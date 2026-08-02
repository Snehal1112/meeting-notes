use super::*;
use meeting_notes_core::meeting::MeetingStatus;
use tempfile::tempdir;

#[test]
fn create_meeting_dir_creates_expected_path() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Team Sync").unwrap();
    assert!(meta.dir_path(base.path()).exists());
    assert_eq!(meta.status, MeetingStatus::Recording);
}

#[test]
fn saves_and_loads_index() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup").unwrap();
    append_to_index(base.path(), &meta).unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].id, meta.id);
}

#[test]
fn update_status_persists_change() {
    let base = tempdir().unwrap();
    let mut meta = create_meeting(base.path(), "Retro").unwrap();
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
    let meta = create_meeting(base.path(), "Standup").unwrap();
    append_to_index(base.path(), &meta).unwrap();

    let mut other_meta = create_meeting(base.path(), "Other").unwrap();
    other_meta.id = "nonexistent-id".to_string();

    let result = update_meeting(base.path(), &other_meta);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
}
