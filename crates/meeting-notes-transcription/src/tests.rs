use super::*;

#[test]
fn whisper_binary_candidates_checks_home_then_system_paths_in_order() {
    let home = Path::new("/home/alice");

    let candidates = whisper_binary_candidates(Some(home));

    assert_eq!(
        candidates,
        vec![
            PathBuf::from("/home/alice/.local/bin/whisper-cli"),
            PathBuf::from("/home/alice/.local/lib/whisper.cpp/whisper-cli"),
            PathBuf::from("/usr/local/bin/whisper-cli"),
            PathBuf::from("/usr/bin/whisper-cli"),
        ]
    );
}

#[test]
fn whisper_binary_candidates_skips_home_paths_when_home_unknown() {
    let candidates = whisper_binary_candidates(None);

    assert_eq!(
        candidates,
        vec![
            PathBuf::from("/usr/local/bin/whisper-cli"),
            PathBuf::from("/usr/bin/whisper-cli"),
        ]
    );
}

#[test]
fn resolve_whisper_binary_prefers_env_override_over_everything() {
    let resolved = resolve_whisper_binary(
        Some("/custom/whisper-cli".to_string()),
        Some(Path::new("/home/alice")),
        |_| true, // even if candidates "exist", the override wins
    );

    assert_eq!(resolved, "/custom/whisper-cli");
}

#[test]
fn resolve_whisper_binary_finds_first_existing_candidate() {
    let resolved = resolve_whisper_binary(None, Some(Path::new("/home/alice")), |p| {
        p == Path::new("/home/alice/.local/lib/whisper.cpp/whisper-cli")
    });

    assert_eq!(resolved, "/home/alice/.local/lib/whisper.cpp/whisper-cli");
}

#[test]
fn resolve_whisper_binary_falls_back_to_bare_name_when_nothing_found() {
    let resolved = resolve_whisper_binary(None, Some(Path::new("/home/alice")), |_| false);

    assert_eq!(resolved, "whisper-cli");
}

#[test]
fn resolve_whisper_model_path_prefers_env_override() {
    let resolved = resolve_whisper_model_path(
        "base.en",
        Some("/custom/models".to_string()),
        Some(Path::new("/home/alice/.local/share/meeting-notes")),
        |_| true,
    );

    assert_eq!(resolved, PathBuf::from("/custom/models/ggml-base.en.bin"));
}

#[test]
fn resolve_whisper_model_path_prefers_data_dir_when_model_exists_there() {
    let data_dir = Path::new("/home/alice/.local/share/meeting-notes");

    let resolved = resolve_whisper_model_path("base.en", None, Some(data_dir), |p| {
        p == Path::new("/home/alice/.local/share/meeting-notes/models/ggml-base.en.bin")
    });

    assert_eq!(
        resolved,
        PathBuf::from("/home/alice/.local/share/meeting-notes/models/ggml-base.en.bin")
    );
}

#[test]
fn resolve_whisper_model_path_falls_back_to_cwd_relative_when_nothing_found_in_data_dir() {
    let data_dir = Path::new("/home/alice/.local/share/meeting-notes");

    let resolved = resolve_whisper_model_path("base.en", None, Some(data_dir), |p| {
        p == Path::new("models/ggml-base.en.bin")
    });

    assert_eq!(resolved, PathBuf::from("models/ggml-base.en.bin"));
}

#[test]
fn resolve_whisper_model_path_defaults_to_data_dir_when_nothing_exists_anywhere() {
    let data_dir = Path::new("/home/alice/.local/share/meeting-notes");

    let resolved = resolve_whisper_model_path("base.en", None, Some(data_dir), |_| false);

    assert_eq!(
        resolved,
        PathBuf::from("/home/alice/.local/share/meeting-notes/models/ggml-base.en.bin")
    );
}

#[test]
fn resolve_whisper_model_path_defaults_to_cwd_relative_when_data_dir_unknown() {
    let resolved = resolve_whisper_model_path("base.en", None, None, |_| false);

    assert_eq!(resolved, PathBuf::from("models/ggml-base.en.bin"));
}

#[test]
fn whisper_model_path_uses_the_caller_supplied_data_dir_not_a_hardcoded_default() {
    // Simulates a user who configured a custom Storage Location (data_dir):
    // the resolved model path must follow that override, not silently fall
    // back to the OS-default `~/.local/share/meeting-notes`.
    let data_dir = Path::new("/home/alice/data/rocket/notes");

    let resolved = whisper_model_path("base.en", Some(data_dir));

    assert_eq!(
        resolved,
        PathBuf::from("/home/alice/data/rocket/notes/models/ggml-base.en.bin")
    );
}

#[test]
#[ignore] // requires an installed whisper.cpp binary + model on the dev machine
fn transcribes_a_short_sample_wav() {
    // No CWD or env var setup needed: run_whisper resolves the whisper-cli
    // binary via whisper_binary_path's auto-discovery (well-known install
    // locations), the same as a real deb-installed, desktop-launched app.
    // data_dir mirrors what a real caller passes when the user hasn't
    // configured a custom Storage Location: the OS default data directory,
    // where the model fixture for this test is expected to live.
    let sample = std::path::Path::new("../../test-fixtures/jfk.wav")
        .canonicalize()
        .expect("sample fixture should exist");
    let home = std::env::var("HOME").expect("HOME should be set");
    let data_dir = std::path::PathBuf::from(home).join(".local/share/meeting-notes");

    let result =
        run_whisper(&sample, "base.en", Some(&data_dir)).expect("transcription should succeed");

    // Clean up the whisper.cpp json artifact written next to the fixture.
    let _ = std::fs::remove_file(sample.with_extension("json"));

    assert!(!result.segments.is_empty());
    assert!(result.segments[0].text.to_lowercase().contains("country"));
}

#[test]
fn run_whisper_error_names_the_resolved_binary_and_hints_at_the_override() {
    unsafe { std::env::set_var("MEETING_NOTES_WHISPER_BIN", "/definitely/does/not/exist/whisper-cli") };

    let result = run_whisper(Path::new("/tmp/does-not-matter.wav"), "base.en", None);

    unsafe { std::env::remove_var("MEETING_NOTES_WHISPER_BIN") };

    let err = result.expect_err("spawning a nonexistent binary should fail");
    assert!(err.contains("/definitely/does/not/exist/whisper-cli"), "{err}");
    assert!(err.contains("MEETING_NOTES_WHISPER_BIN"), "{err}");
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
