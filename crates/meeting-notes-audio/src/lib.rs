use std::path::{Path, PathBuf};
use std::process::{Child, Command};

/// Number of leading milliseconds discarded from every recording to skip the
/// startup DC-offset step / filter settling time seen on this dev machine's
/// PipeWire DC-blocking filter chain. See docs/superpowers/specs/environment.md,
/// "Task 2: PipeWire audio capture" for the full story.
const TRIM_LEADING_MS: u32 = 500;

/// Mean sample value (out of i16 full scale, -32768..32767) above which a
/// recording is considered to have a suspicious DC offset.
const DC_OFFSET_THRESHOLD: f64 = 1000.0;

/// Absolute sample value at/above which a sample counts as clipped.
const CLIPPING_SAMPLE_THRESHOLD: i16 = 32000;

/// Fraction of samples that must be clipped for a recording to be flagged.
const CLIPPING_RATIO_THRESHOLD: f64 = 0.01;

/// Errors that can occur while recording or validating a recording.
#[derive(Debug)]
pub enum RecordingError {
    /// An I/O error occurred while spawning, waiting on, or signaling the
    /// `pw-record` child process, or while creating parent directories for
    /// the output file.
    Io(std::io::Error),
    /// An error occurred while reading or writing the WAV file itself
    /// (via `hound`).
    Wav(hound::Error),
}

impl std::fmt::Display for RecordingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordingError::Io(e) => write!(f, "recording I/O error: {e}"),
            RecordingError::Wav(e) => write!(f, "recording WAV read/write error: {e}"),
        }
    }
}

impl std::error::Error for RecordingError {}

/// The recording finished and was saved, but its audio characteristics look
/// like a DC offset or clipping mic hardware/config issue rather than real
/// captured audio. The (trimmed) file is still written to disk regardless —
/// this is a quality warning, not a failure.
#[derive(Debug, Clone)]
pub struct QualityWarning {
    pub dc_offset_mean: f64,
    pub clipping_ratio: f64,
}

impl std::fmt::Display for QualityWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "recording captured but looks like a mic hardware/config issue \
             (DC offset or clipping) rather than real audio \
             (dc_offset_mean={:.1}, clipping_ratio={:.4})",
            self.dc_offset_mean, self.clipping_ratio
        )
    }
}

impl From<std::io::Error> for RecordingError {
    fn from(e: std::io::Error) -> Self {
        RecordingError::Io(e)
    }
}

impl From<hound::Error> for RecordingError {
    fn from(e: hound::Error) -> Self {
        RecordingError::Wav(e)
    }
}

pub struct RecordingHandle {
    child: Child,
    output_path: PathBuf,
}

impl RecordingHandle {
    /// Starts recording default mic input to `output_path` as a WAV file via pw-record.
    pub fn start_mic(output_path: &Path) -> std::io::Result<Self> {
        let child = Command::new("pw-record")
            .arg("--channels=1")
            .arg("--rate=16000")
            .arg(output_path)
            .spawn()?;
        Ok(RecordingHandle {
            child,
            output_path: output_path.to_path_buf(),
        })
    }

    /// Stops the recording by sending SIGTERM so pw-record finalizes the WAV file,
    /// then trims the leading DC-offset settling window and checks the recording
    /// for signs of a DC-offset/clipping mic fault. The (trimmed) file is always
    /// written back to `output_path`, even when a quality warning is returned, so
    /// the caller still has the recording available — just flagged as suspect.
    pub fn stop(&mut self) -> Result<Option<QualityWarning>, RecordingError> {
        // pw-record needs a graceful signal (not kill -9) to write valid WAV headers.
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        self.child.wait()?;

        trim_and_check_file(&self.output_path)
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

impl Drop for RecordingHandle {
    fn drop(&mut self) {
        // Best-effort: if the process already exited, this is a no-op signal to a dead pid.
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let _ = self.child.wait();
    }
}

/// Reads the WAV file at `path`, trims the leading DC-offset settling window,
/// checks recording quality, and writes the trimmed samples back to `path`.
/// Returns the quality warning, if any. Factored out of `stop()` so it can be
/// unit tested against a synthetic WAV file without `pw-record` or real
/// hardware.
fn trim_and_check_file(path: &Path) -> Result<Option<QualityWarning>, RecordingError> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let samples: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<Vec<i16>, hound::Error>>()?;

    let (trimmed, warning) = analyze_and_trim(&samples, spec.sample_rate);

    let mut writer = hound::WavWriter::create(path, spec)?;
    for sample in &trimmed {
        writer.write_sample(*sample)?;
    }
    writer.finalize()?;

    Ok(warning)
}

/// Trims the leading DC-offset settling window and checks recording quality.
/// Returns the samples to keep (trimmed) and an optional quality warning.
/// Pure function, no I/O, so it can be unit tested without `pw-record` or
/// real hardware.
fn analyze_and_trim(samples: &[i16], sample_rate: u32) -> (Vec<i16>, Option<QualityWarning>) {
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;

    // Guard: if the recording is shorter than the trim window (e.g. very short
    // recordings, including a 500ms test recording), skip trimming AND skip the
    // quality check entirely rather than computing over an empty/near-empty slice.
    if samples.len() <= trim_count {
        return (samples.to_vec(), None);
    }

    let remaining = &samples[trim_count..];
    let dc_offset_mean =
        remaining.iter().map(|&s| s as f64).sum::<f64>() / remaining.len() as f64;
    let clipped = remaining
        .iter()
        .filter(|&&s| s.unsigned_abs() as i32 >= CLIPPING_SAMPLE_THRESHOLD as i32)
        .count();
    let clipping_ratio = clipped as f64 / remaining.len() as f64;

    let warning = if dc_offset_mean.abs() > DC_OFFSET_THRESHOLD
        || clipping_ratio > CLIPPING_RATIO_THRESHOLD
    {
        Some(QualityWarning {
            dc_offset_mean,
            clipping_ratio,
        })
    } else {
        None
    };

    (remaining.to_vec(), warning)
}

/// Runs `wpctl status` and returns the numeric node id of the default
/// (`*`-marked) sink, or `None` if `wpctl` isn't found, exits non-zero, or no
/// default sink is found.
///
/// Note: plain PipeWire (no PulseAudio compatibility layer) has no
/// `pactl`-style `"<sink>.monitor"` source name to target — capturing a
/// sink's audio requires targeting the sink's own node id with `pw-record
/// --target <id> -P '{ stream.capture.sink=true }'`. See
/// docs/superpowers/specs/environment.md, "Task 2: PipeWire audio capture",
/// for the verified-working command and the environment where `pactl` isn't
/// installed at all.
pub fn find_default_sink_id() -> Option<u32> {
    let output = Command::new("wpctl").arg("status").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_default_sink_id(&stdout)
}

/// Parses `wpctl status` output and returns the numeric node id of the line
/// marked `*` under the "Sinks:" section specifically (not "Sources:",
/// "Sink endpoints:", or any other section — we want a playback sink to
/// monitor, not a capture source). Pure function, no I/O, so it can be unit
/// tested without `wpctl` installed or real hardware.
fn parse_default_sink_id(wpctl_status_output: &str) -> Option<u32> {
    let mut in_sinks = false;
    for line in wpctl_status_output.lines() {
        let trimmed = line.trim();
        if trimmed.ends_with("Sinks:") {
            // Matches "Sinks:" but not "Sink endpoints:" (which doesn't end
            // with "Sinks:"), so we don't accidentally scan that section too.
            in_sinks = true;
            continue;
        }
        if trimmed.ends_with(':') {
            // Any other section header (Sources:, Sink endpoints:, Streams:,
            // Devices:, ...) ends the Sinks section.
            in_sinks = false;
            continue;
        }
        if !in_sinks {
            continue;
        }
        if let Some(star_pos) = line.find('*') {
            let rest = line[star_pos + 1..].trim_start();
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(id) = digits.parse::<u32>() {
                return Some(id);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests;
