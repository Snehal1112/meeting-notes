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
