use super::*;
use meeting_notes_core::meeting::{MeetingStatus, MeetingType};
use tempfile::tempdir;

#[test]
fn base_dir_uses_explicit_override_when_provided() {
    let override_path = PathBuf::from("/tmp/custom-meeting-notes-location");
    let resolved = base_dir(Some(&override_path));
    assert_eq!(resolved, Some(override_path));
}

#[test]
fn base_dir_falls_back_to_default_when_no_override() {
    let resolved = base_dir(None);
    assert!(resolved.is_some());
}

#[test]
fn create_meeting_dir_creates_expected_path() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Team Sync", MeetingType::AutoDetect).unwrap();
    assert!(meta.dir_path(base.path()).exists());
    assert_eq!(meta.status, MeetingStatus::Recording);
}

#[test]
fn create_meeting_accepts_a_meeting_type() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Daily Sync", MeetingType::Standup).unwrap();
    assert_eq!(meta.meeting_type, MeetingType::Standup);
}

#[test]
fn loads_an_index_written_before_meeting_type_existed() {
    // Meetings recorded before MeetingType was added have no `meeting_type`
    // key. load_index turns any deserialize failure into a hard error, so
    // without a serde default the field would make every pre-existing
    // meeting on disk unreadable.
    let base = tempdir().unwrap();
    std::fs::write(
        base.path().join("index.json"),
        r#"[{"id":"2026-08-02_113804_snehal","title":"snehal",
             "created_at":"2026-08-02T11:38:04+00:00","duration_seconds":42,
             "status":"Done","used_system_audio":false}]"#,
    )
    .unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].meeting_type, MeetingType::AutoDetect);
}

#[test]
fn saves_and_loads_index() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].id, meta.id);
}

#[test]
fn update_status_persists_change() {
    let base = tempdir().unwrap();
    let mut meta = create_meeting(base.path(), "Retro", MeetingType::Retrospective).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    meta.status = MeetingStatus::Done;
    meta.duration_seconds = Some(1800);
    update_meeting(base.path(), &meta).unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index[0].status, MeetingStatus::Done);
    assert_eq!(index[0].duration_seconds, Some(1800));
}

#[test]
fn set_meeting_status_updates_status_duration_and_system_audio_leaving_other_fields_untouched() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Retro", MeetingType::Retrospective).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    set_meeting_status(base.path(), &meta.id, MeetingStatus::Transcribing, Some(120), Some(true))
        .unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index[0].status, MeetingStatus::Transcribing);
    assert_eq!(index[0].duration_seconds, Some(120));
    assert!(index[0].used_system_audio);
    // A client-supplied title/meeting_type must never round-trip through
    // this command — unlike update_meeting (used only with server-computed
    // records), set_meeting_status is the one exposed directly to the
    // untrusted renderer over IPC.
    assert_eq!(index[0].title, "Retro");
    assert_eq!(index[0].meeting_type, MeetingType::Retrospective);
}

#[test]
fn set_meeting_status_leaves_duration_and_system_audio_unchanged_when_none_is_passed() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup", MeetingType::Standup).unwrap();
    append_to_index(base.path(), &meta).unwrap();
    set_meeting_status(base.path(), &meta.id, MeetingStatus::Transcribing, Some(500), Some(true))
        .unwrap();

    set_meeting_status(base.path(), &meta.id, MeetingStatus::Failed, None, None).unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index[0].status, MeetingStatus::Failed);
    assert_eq!(index[0].duration_seconds, Some(500));
    assert!(index[0].used_system_audio);
}

#[test]
fn set_meeting_status_errors_when_id_not_found() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    let result = set_meeting_status(base.path(), "nonexistent-id", MeetingStatus::Failed, None, None);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn load_index_errors_on_corrupt_json() {
    let base = tempdir().unwrap();
    std::fs::write(base.path().join("index.json"), "{invalid json").unwrap();

    let result = load_index(base.path());
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
}

#[test]
fn update_meeting_errors_when_id_not_found() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    let mut other_meta = create_meeting(base.path(), "Other", MeetingType::AutoDetect).unwrap();
    other_meta.id = "nonexistent-id".to_string();

    let result = update_meeting(base.path(), &other_meta);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn find_orphaned_meetings_returns_only_recording_status() {
    let base = tempdir().unwrap();

    let orphan = create_meeting(base.path(), "Interrupted call", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &orphan).unwrap();

    let mut finished = create_meeting(base.path(), "Finished call", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &finished).unwrap();
    finished.status = MeetingStatus::Done;
    finished.duration_seconds = Some(600);
    update_meeting(base.path(), &finished).unwrap();

    let orphans = find_orphaned_meetings(base.path()).unwrap();
    assert_eq!(orphans.len(), 1);
    assert_eq!(orphans[0].id, orphan.id);
}

#[test]
fn find_orphaned_meetings_returns_empty_when_no_index() {
    let base = tempdir().unwrap();
    let orphans = find_orphaned_meetings(base.path()).unwrap();
    assert!(orphans.is_empty());
}

#[test]
fn save_index_does_not_leak_tmp_file() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    assert!(!base.path().join("index.json.tmp").exists());
    assert!(base.path().join("index.json").exists());
}

#[test]
fn save_index_overwrites_leftover_tmp_file_from_a_prior_crash() {
    let base = tempdir().unwrap();

    // Simulate a leftover temp file from a process that got killed mid-write
    // during a previous save_index call.
    std::fs::write(base.path().join("index.json.tmp"), "garbage, not json").unwrap();

    let meta = create_meeting(base.path(), "Standup", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();

    // The stray tmp file must not corrupt the fresh save, and must not
    // survive as leftover cruft after a subsequent successful save.
    assert!(!base.path().join("index.json.tmp").exists());
    let index = load_index(base.path()).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].id, meta.id);
}

#[test]
fn extracts_summary_snippet_from_summary_result_json() {
    let dir = tempdir().unwrap();
    let meeting_dir = dir.path().join("meetings").join("test-meeting");
    std::fs::create_dir_all(&meeting_dir).unwrap();
    std::fs::write(
        meeting_dir.join("summary_result.json"),
        r#"{"summary": "Discussed Q3 roadmap timeline and blockers on the API migration in detail across the whole hour."}"#,
    )
    .unwrap();

    let snippet = extract_summary_snippet(&meeting_dir, 60);
    assert_eq!(
        snippet,
        Some("Discussed Q3 roadmap timeline and blockers on the API migrat…".to_string())
    );
}

#[test]
fn returns_none_snippet_when_no_summary_result_exists() {
    let dir = tempdir().unwrap();
    let meeting_dir = dir.path().join("meetings").join("no-summary-yet");
    std::fs::create_dir_all(&meeting_dir).unwrap();
    assert_eq!(extract_summary_snippet(&meeting_dir, 60), None);
}

#[test]
fn delete_meeting_removes_directory_and_index_entry() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "To Delete", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();
    assert!(meta.dir_path(base.path()).exists());

    delete_meeting(base.path(), &meta.id).unwrap();

    assert!(!meta.dir_path(base.path()).exists());
    let index = load_index(base.path()).unwrap();
    assert!(index.iter().all(|m| m.id != meta.id));
}

#[test]
fn delete_meeting_is_a_noop_error_for_unknown_id() {
    let base = tempdir().unwrap();
    let result = delete_meeting(base.path(), "does-not-exist");
    assert!(result.is_err());
}
