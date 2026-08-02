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
