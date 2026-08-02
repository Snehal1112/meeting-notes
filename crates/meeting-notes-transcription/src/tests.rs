use super::*;

/// Restores the process's original working directory on drop, including on
/// the panic/unwind path (e.g. an `expect` failure), so a CWD mutation made by
/// one test can't leak into any other test that might run in the same binary.
struct CwdGuard(std::path::PathBuf);

impl CwdGuard {
    fn new() -> Self {
        Self(std::env::current_dir().expect("current dir should be readable"))
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.0);
    }
}

#[test]
#[ignore] // requires a bundled whisper.cpp binary + model on the dev machine
fn transcribes_a_short_sample_wav() {
    // `cargo test` runs this binary with its CWD set to this crate's own
    // directory (crates/meeting-notes-transcription), but run_whisper resolves
    // the model at the relative path "models/ggml-{model}.bin". Canonicalize the
    // fixture path first, then switch CWD to src-tauri/ (where the bundled
    // model actually lives) before invoking run_whisper. The guard restores the
    // original CWD when it goes out of scope, even if a panic unwinds through.
    let _cwd_guard = CwdGuard::new();
    let sample = std::path::Path::new("../../test-fixtures/jfk.wav")
        .canonicalize()
        .expect("sample fixture should exist");
    std::env::set_current_dir("../../src-tauri").expect("src-tauri dir should exist");

    let result = run_whisper(&sample, "base.en").expect("transcription should succeed");

    // Clean up the whisper.cpp json artifact written next to the fixture.
    let _ = std::fs::remove_file(sample.with_extension("json"));

    assert!(!result.segments.is_empty());
    assert!(result.segments[0].text.to_lowercase().contains("country"));
}
