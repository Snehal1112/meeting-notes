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

#[test]
fn saves_transcript_json_and_txt() {
    let dir = std::env::temp_dir().join(format!("transcript-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let result = TranscriptResult {
        segments: vec![
            TranscriptSegment { start_time: 0.0, end_time: 1.5, text: "Hello team.".into() },
            TranscriptSegment { start_time: 1.5, end_time: 3.0, text: "Let's get started.".into() },
        ],
    };

    save_transcript(&dir, &result).unwrap();

    let json = std::fs::read_to_string(dir.join("transcript.json")).unwrap();
    let parsed: Vec<TranscriptSegment> =
        serde_json::from_str(&json).expect("transcript.json should round-trip as segments");
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].start_time, 0.0);
    assert_eq!(parsed[0].end_time, 1.5);
    assert_eq!(parsed[0].text, "Hello team.");
    assert_eq!(parsed[1].start_time, 1.5);
    assert_eq!(parsed[1].end_time, 3.0);
    assert_eq!(parsed[1].text, "Let's get started.");

    let txt = std::fs::read_to_string(dir.join("transcript.txt")).unwrap();
    assert_eq!(txt, "Hello team. Let's get started.");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn parse_whisper_json_converts_offsets_to_seconds_and_trims_text() {
    let contents = r#"{
        "transcription": [
            {"offsets": {"from": 0, "to": 1500}, "text": " Hello team."},
            {"offsets": {"from": 1500, "to": 3200}, "text": " Let's get started."}
        ]
    }"#;

    let result = parse_whisper_json(contents).expect("valid whisper json should parse");

    assert_eq!(result.segments.len(), 2);
    assert_eq!(result.segments[0].start_time, 0.0);
    assert_eq!(result.segments[0].end_time, 1.5);
    assert_eq!(result.segments[0].text, "Hello team.");
    assert_eq!(result.segments[1].start_time, 1.5);
    assert_eq!(result.segments[1].end_time, 3.2);
    assert_eq!(result.segments[1].text, "Let's get started.");
}

#[test]
fn parse_whisper_json_falls_back_when_offsets_missing() {
    // Documents current fallback behavior (not a desired end state): a segment
    // missing "offsets" degrades to zeroed timestamps rather than an error,
    // via the `.unwrap_or(0.0)` in parse_whisper_json.
    let contents = r#"{
        "transcription": [
            {"text": "No offsets here."}
        ]
    }"#;

    let result = parse_whisper_json(contents).expect("missing offsets should not error");

    assert_eq!(result.segments.len(), 1);
    assert_eq!(result.segments[0].start_time, 0.0);
    assert_eq!(result.segments[0].end_time, 0.0);
    assert_eq!(result.segments[0].text, "No offsets here.");
}

#[test]
fn parse_whisper_json_rejects_malformed_json() {
    let contents = "not valid json at all {{{";

    let result = parse_whisper_json(contents);

    assert!(result.is_err());
}
