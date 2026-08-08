use std::path::Path;

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
    /// platform's capture process, or while creating parent directories for
    /// the output file.
    Io(std::io::Error),
    /// An error occurred while reading or writing the WAV file itself
    /// (via `hound`).
    Wav(hound::Error),
    /// An error occurred while mixing the mic and system-audio streams
    /// together (see `mix_wav_files`), which returns a bare `String` rather
    /// than an `Io`/`Wav` error since it can fail for either reason (or
    /// neither, e.g. mismatched specs).
    Mix(String),
}

impl std::fmt::Display for RecordingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordingError::Io(e) => write!(f, "recording I/O error: {e}"),
            RecordingError::Wav(e) => write!(f, "recording WAV read/write error: {e}"),
            RecordingError::Mix(e) => write!(f, "recording mix error: {e}"),
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

/// The recording finished and was saved, but its audio characteristics look
/// like a DC offset or clipping issue rather than real captured audio. This
/// check runs on the final output file, which may be mic-only or a mic+system
/// mix (see `finalize_output`), so the cause could be either stream -- e.g.
/// loud system-audio playback can trip the clipping check even with a
/// perfectly healthy mic. The (trimmed) file is still written to disk
/// regardless — this is a quality warning, not a failure.
#[derive(Debug, Clone)]
pub struct QualityWarning {
    pub dc_offset_mean: f64,
    pub clipping_ratio: f64,
}

impl std::fmt::Display for QualityWarning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "recording captured but looks like a DC offset or clipping issue \
             in the audio (mic and/or system audio) rather than clean signal \
             (dc_offset_mean={:.1}, clipping_ratio={:.4})",
            self.dc_offset_mean, self.clipping_ratio
        )
    }
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::RecordingHandle;

#[cfg(not(target_os = "linux"))]
compile_error!("meeting-notes-audio currently supports Linux only");

pub mod mic_watcher;

/// Assembles the final recording from the mic (and, if present, system)
/// capture files, then runs quality trim/check on the result. On a mix
/// failure, falls back to the mic-only recording rather than losing it --
/// the same graceful degradation as "no system sink found at start()".
/// Factored out as a free function over paths (rather than `&mut self`) so
/// it can be unit tested against synthetic WAV files without a real capture
/// process or hardware, and so every platform backend's `stop()` can share
/// it unchanged.
fn finalize_output(
    mic_path: &Path,
    system_path: Option<&Path>,
    final_output_path: &Path,
) -> Result<Option<QualityWarning>, RecordingError> {
    match system_path {
        Some(sys_path) => {
            if mix_wav_files(mic_path, sys_path, final_output_path).is_err() {
                // Mixing failed -- fall back to the mic-only recording rather
                // than losing a perfectly good capture over a bad system stream.
                std::fs::rename(mic_path, final_output_path)?;
            }
            // Else: mix succeeded and final_output_path now holds the mixed
            // audio. Intermediates are cleaned up below, only after
            // trim_and_check_file's rewrite succeeds -- NOT before it -- so a
            // failure there still leaves the mixed file recoverable.
        }
        None => {
            std::fs::rename(mic_path, final_output_path)?;
        }
    }

    let warning = trim_and_check_file(final_output_path)?;

    // Best-effort cleanup, now that final_output_path holds a fully-processed
    // result. mic_path only still exists here if the mix succeeded (the
    // mic-only and mix-failure-fallback paths above already renamed it away).
    if system_path.is_some() && mic_path.exists() {
        let _ = std::fs::remove_file(mic_path);
    }
    if let Some(sys_path) = system_path {
        let _ = std::fs::remove_file(sys_path);
    }

    Ok(warning)
}

/// The clear "zero samples captured" error shared by `trim_and_check_file`
/// (first-time finalize) and `recover_interrupted_recording` (retry of a
/// meeting whose finalize already left an empty file at `final_output_path`),
/// so both paths report the exact same message instead of drifting apart.
fn zero_samples_error(path: &Path) -> RecordingError {
    RecordingError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("no audio was captured in {path:?} -- the recording contains zero samples"),
    ))
}

/// Reads the WAV file at `path`, trims the leading DC-offset settling window,
/// checks recording quality, and writes the trimmed samples back to `path`.
/// Returns the quality warning, if any. Factored out so it can be unit tested
/// against a synthetic WAV file without a real capture process or hardware.
fn trim_and_check_file(path: &Path) -> Result<Option<QualityWarning>, RecordingError> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let samples: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<Vec<i16>, hound::Error>>()?;

    if samples.is_empty() {
        return Err(zero_samples_error(path));
    }

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
/// Pure function, no I/O, so it can be unit tested without a real capture
/// process or hardware.
fn analyze_and_trim(samples: &[i16], sample_rate: u32) -> (Vec<i16>, Option<QualityWarning>) {
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;

    // Guard: if the recording is shorter than the trim window (e.g. very short
    // recordings, including a 500ms test recording), skip trimming AND skip the
    // quality check entirely rather than computing over an empty/near-empty slice.
    if samples.len() <= trim_count {
        return (samples.to_vec(), None);
    }

    let remaining = &samples[trim_count..];
    let dc_offset_mean = remaining.iter().map(|&s| s as f64).sum::<f64>() / remaining.len() as f64;
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

/// Recovers a recording that was interrupted before `stop()` ever ran (e.g.
/// the app crashed or was killed mid-recording), so `finalize_output` never
/// got a chance to assemble `final_output_path` from the intermediate
/// capture file(s). A no-op if `final_output_path` already exists AND holds
/// real audio (the recording completed normally, nothing to recover).
///
/// If `final_output_path` exists but has zero samples, that is not a
/// successfully finalized recording -- it is the empty file `finalize_output`
/// renamed into place right before `trim_and_check_file` rejected it (see
/// that function). Without re-checking here, retrying such a meeting would
/// hit this early-exists guard, silently return `Ok(None)`, and hand the same
/// empty file to whisper.cpp again, reproducing the original cryptic crash.
/// So the existing file's sample count is re-validated every time, and the
/// same clear "no audio was captured" error is returned again if it's empty.
///
/// Otherwise (no `final_output_path` at all) looks for the same
/// `<stem>.mic.wav` / `<stem>.system.wav` intermediates that
/// `RecordingHandle::start` creates (see `linux.rs`) and finalizes
/// whichever are present. Errors if neither the final output nor the mic
/// intermediate exists -- genuine data loss, since nothing was ever captured.
pub fn recover_interrupted_recording(
    final_output_path: &Path,
) -> Result<Option<QualityWarning>, RecordingError> {
    if final_output_path.exists() {
        // Cheap re-validation: just the frame count from the header, not a
        // full sample read like trim_and_check_file's rewrite path needs.
        let reader = hound::WavReader::open(final_output_path)?;
        if reader.duration() == 0 {
            return Err(zero_samples_error(final_output_path));
        }
        return Ok(None);
    }

    let mic_path = final_output_path.with_extension("mic.wav");
    if !mic_path.exists() {
        return Err(RecordingError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "no audio was ever captured: neither {final_output_path:?} nor {mic_path:?} exist"
            ),
        )));
    }

    let system_path = final_output_path.with_extension("system.wav");
    let system_path = system_path.exists().then_some(system_path);

    finalize_output(&mic_path, system_path.as_deref(), final_output_path)
}

/// Mixes two WAV files sample-by-sample into `out_path`, using the WAV spec
/// (channels, sample rate, bit depth) of `a_path`. Samples are summed and
/// clamped to the `i16` range to avoid wraparound on clipping. If the two
/// inputs have different lengths, the shorter one is treated as silent (0)
/// for the remaining samples, so the output length matches the longer input.
pub fn mix_wav_files(a_path: &Path, b_path: &Path, out_path: &Path) -> Result<(), String> {
    let mut a_reader = hound::WavReader::open(a_path).map_err(|e| e.to_string())?;
    let mut b_reader = hound::WavReader::open(b_path).map_err(|e| e.to_string())?;
    let spec = a_reader.spec();
    let b_spec = b_reader.spec();
    if spec != b_spec {
        return Err(format!(
            "cannot mix WAVs with mismatched specs: {a_path:?} has {spec:?}, \
             {b_path:?} has {b_spec:?}"
        ));
    }

    let a_samples: Vec<i16> = a_reader.samples::<i16>().filter_map(|s| s.ok()).collect();
    let b_samples: Vec<i16> = b_reader.samples::<i16>().filter_map(|s| s.ok()).collect();
    let len = a_samples.len().max(b_samples.len());

    let mut writer = hound::WavWriter::create(out_path, spec).map_err(|e| e.to_string())?;
    for i in 0..len {
        let a = *a_samples.get(i).unwrap_or(&0) as i32;
        let b = *b_samples.get(i).unwrap_or(&0) as i32;
        let mixed = (a + b).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        writer.write_sample(mixed).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests;
