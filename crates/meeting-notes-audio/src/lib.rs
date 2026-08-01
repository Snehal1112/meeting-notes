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
    /// `pw-record` child process, or while reading/writing the WAV file.
    Io(std::io::Error),
    /// An error occurred while reading or writing the WAV file itself.
    Wav(hound::Error),
    /// The recording finished and was saved, but its audio characteristics
    /// look like a DC offset or clipping mic hardware/config issue rather
    /// than real captured audio. The file is still written to disk.
    LikelyMicFault {
        dc_offset_mean: f64,
        clipping_ratio: f64,
    },
}

impl std::fmt::Display for RecordingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordingError::Io(e) => write!(f, "recording I/O error: {e}"),
            RecordingError::Wav(e) => write!(f, "recording WAV read/write error: {e}"),
            RecordingError::LikelyMicFault {
                dc_offset_mean,
                clipping_ratio,
            } => write!(
                f,
                "recording captured but looks like a mic hardware/config issue \
                 (DC offset or clipping) rather than real audio \
                 (dc_offset_mean={dc_offset_mean:.1}, clipping_ratio={clipping_ratio:.4})"
            ),
        }
    }
}

impl std::error::Error for RecordingError {}

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
    /// written back to `output_path`, even when a fault is detected, so the
    /// caller still has the recording available — just flagged as suspect.
    pub fn stop(&mut self) -> Result<(), RecordingError> {
        // pw-record needs a graceful signal (not kill -9) to write valid WAV headers.
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        self.child.wait()?;

        let mut reader = hound::WavReader::open(&self.output_path)?;
        let spec = reader.spec();
        let samples: Vec<i16> = reader
            .samples::<i16>()
            .collect::<Result<Vec<i16>, hound::Error>>()?;

        let (trimmed, verdict) = analyze_and_trim(&samples, spec.sample_rate);

        let mut writer = hound::WavWriter::create(&self.output_path, spec)?;
        for sample in &trimmed {
            writer.write_sample(*sample)?;
        }
        writer.finalize()?;

        verdict
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

/// Trims the leading DC-offset settling window and checks recording quality.
/// Returns the samples to keep (trimmed) and a quality verdict. Pure function,
/// no I/O, so it can be unit tested without `pw-record` or real hardware.
fn analyze_and_trim(samples: &[i16], sample_rate: u32) -> (Vec<i16>, Result<(), RecordingError>) {
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;

    // Guard: if the recording is shorter than the trim window (e.g. very short
    // recordings, including a 500ms test recording), skip trimming AND skip the
    // quality check entirely rather than computing over an empty/near-empty slice.
    if samples.len() <= trim_count {
        return (samples.to_vec(), Ok(()));
    }

    let remaining = &samples[trim_count..];
    let dc_offset_mean =
        remaining.iter().map(|&s| s as f64).sum::<f64>() / remaining.len() as f64;
    let clipped = remaining
        .iter()
        .filter(|&&s| s.unsigned_abs() as i32 >= CLIPPING_SAMPLE_THRESHOLD as i32)
        .count();
    let clipping_ratio = clipped as f64 / remaining.len() as f64;

    let verdict = if dc_offset_mean.abs() > DC_OFFSET_THRESHOLD
        || clipping_ratio > CLIPPING_RATIO_THRESHOLD
    {
        Err(RecordingError::LikelyMicFault {
            dc_offset_mean,
            clipping_ratio,
        })
    } else {
        Ok(())
    };

    (remaining.to_vec(), verdict)
}

#[cfg(test)]
mod tests;
