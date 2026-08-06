use meeting_notes_storage::{load_index, save_index};
use std::path::{Path, PathBuf};

#[tauri::command]
pub fn count_meetings_at(path: String) -> Result<usize, String> {
    let dir = PathBuf::from(path);
    if !dir.exists() {
        return Ok(0);
    }
    load_index(&dir).map(|index| index.len()).map_err(|e| e.to_string())
}

/// Moves every meeting directory from `from`'s `meetings/` folder into
/// `to`'s, then merges the two `index.json`s by id (destination wins on a
/// conflict, matching `migrate_meetings`'s existing "keep target's copy"
/// semantics) and rewrites the source index to drop whatever actually moved.
///
/// Non-transactional by directory rather than all-or-nothing: a single
/// directory's move failing does not abort the rest. Both indices are
/// still written for whatever *did* succeed, so a partial failure can never
/// leave files on disk that aren't listed in either index. If anything
/// failed to move, its directory and index entry both stay at `from`, and
/// the returned `Err` names it.
#[tauri::command]
pub fn migrate_meetings(from: String, to: String) -> Result<(), String> {
    let from_base = PathBuf::from(&from);
    let to_base = PathBuf::from(&to);
    let from_dir = from_base.join("meetings");
    let to_dir = to_base.join("meetings");
    std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;

    let mut moved_ids: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    if from_dir.exists() {
        for entry in std::fs::read_dir(&from_dir).map_err(|e| e.to_string())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    failures.push(e.to_string());
                    continue;
                }
            };
            let name = entry.file_name();
            let id = name.to_string_lossy().to_string();
            let dest = to_dir.join(&name);
            match move_dir(&entry.path(), &dest) {
                Ok(()) => moved_ids.push(id),
                Err(e) => failures.push(format!("{id}: {e}")),
            }
        }
    }

    // Merge index.json entries (by id, destination wins) rather than
    // overwriting -- the target location may already have its own meetings
    // if the user is switching back to a previously-used folder. Only
    // entries whose directory actually made it to `to` above are merged in;
    // anything that failed to move stays out of `to`'s index so it never
    // lists a meeting with no files behind it there.
    let from_index = load_index(&from_base).unwrap_or_default();
    let mut to_index = load_index(&to_base).unwrap_or_default();
    let mut unmoved_meta = Vec::new();
    for meeting in from_index {
        if moved_ids.contains(&meeting.id) {
            if !to_index.iter().any(|m| m.id == meeting.id) {
                to_index.push(meeting);
            }
        } else {
            unmoved_meta.push(meeting);
        }
    }
    save_index(&to_base, &to_index).map_err(|e| e.to_string())?;

    // Drop the migrated entries from the source index so it doesn't keep
    // listing meetings whose folders no longer exist there -- a stale
    // Recording-status entry would otherwise resurface via
    // find_orphaned_meetings as a resumable recording if the user ever
    // points the app back at this location. Only rewritten when `from_base`
    // itself exists, since an index write needs somewhere to put the temp
    // file (see `save_index`) and a from-location that was never used has
    // nothing to clean up anyway.
    if from_base.exists() {
        save_index(&from_base, &unmoved_meta).map_err(|e| e.to_string())?;
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "moved to the new location, but {} meeting folder(s) could not be moved: {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

/// Moves a single meeting directory, falling back to a recursive
/// copy-then-remove when `fs::rename` fails. The common real-world failure
/// is `EXDEV` ("Invalid cross-device link"), which `rename` always returns
/// when `src` and `dest` are on different filesystems -- e.g. an external
/// drive or separate partition, the main reason anyone changes the storage
/// location in the first place. Any other rename failure falls back the
/// same way rather than trying to distinguish the error, on the theory that
/// a copy-then-remove that succeeds is strictly better than a rename that
/// didn't.
fn move_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir_recursive(src, dest)?;
    std::fs::remove_dir_all(src)
}

/// Recursively copies `src`'s contents into `dest`, creating `dest` (and any
/// missing parent directories) as needed.
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus, MeetingType};

    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "meeting-notes-data-dir-commands-test-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        std::fs::create_dir_all(&dir).expect("create temp base dir");
        dir
    }

    fn meta(id: &str, title: &str) -> MeetingMeta {
        MeetingMeta {
            id: id.to_string(),
            title: title.to_string(),
            created_at: "2026-08-01T10:00:00+00:00".to_string(),
            duration_seconds: None,
            status: MeetingStatus::Done,
            used_system_audio: false,
            meeting_type: MeetingType::AutoDetect,
        }
    }

    fn write_index(base: &Path, index: &[MeetingMeta]) {
        save_index(base, index).expect("write index");
    }

    fn write_meeting_dir(base: &Path, id: &str) {
        let dir = base.join("meetings").join(id);
        std::fs::create_dir_all(&dir).expect("create meeting dir");
        std::fs::write(dir.join("summary.md"), "hello").expect("write summary.md");
    }

    #[test]
    fn migrate_merges_non_overlapping_entries_and_moves_files() {
        let from = temp_base("non-overlap-from");
        let to = temp_base("non-overlap-to");

        write_meeting_dir(&from, "a");
        write_index(&from, &[meta("a", "A")]);
        write_meeting_dir(&to, "b");
        write_index(&to, &[meta("b", "B")]);

        migrate_meetings(from.to_string_lossy().to_string(), to.to_string_lossy().to_string())
            .expect("migrate succeeds");

        let to_index = load_index(&to).expect("load to index");
        let mut ids: Vec<&str> = to_index.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["a", "b"], "destination index should be the union of both");
        assert!(to.join("meetings").join("a").join("summary.md").exists());
        assert!(to.join("meetings").join("b").join("summary.md").exists());

        std::fs::remove_dir_all(&from).ok();
        std::fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn migrate_drops_moved_entries_from_the_source_index() {
        // Finding #4: after a successful move, the source index.json must
        // no longer list the meetings that moved -- otherwise pointing the
        // app back at the old location would show ghosts whose folders no
        // longer exist.
        let from = temp_base("drop-source-from");
        let to = temp_base("drop-source-to");

        write_meeting_dir(&from, "a");
        write_index(&from, &[meta("a", "A")]);

        migrate_meetings(from.to_string_lossy().to_string(), to.to_string_lossy().to_string())
            .expect("migrate succeeds");

        let from_index = load_index(&from).expect("load from index");
        assert!(from_index.is_empty(), "moved entry must be removed from the source index");

        std::fs::remove_dir_all(&from).ok();
        std::fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn migrate_keeps_the_destination_entry_on_an_id_conflict() {
        // Asserts current merge-by-id semantics: on a conflict the
        // destination's existing entry wins and the source's copy of that
        // same id is discarded, rather than overwriting it.
        let from = temp_base("conflict-from");
        let to = temp_base("conflict-to");

        write_meeting_dir(&from, "dup");
        write_index(&from, &[meta("dup", "Source Title")]);
        write_index(&to, &[meta("dup", "Destination Title")]);

        migrate_meetings(from.to_string_lossy().to_string(), to.to_string_lossy().to_string())
            .expect("migrate succeeds");

        let to_index = load_index(&to).expect("load to index");
        assert_eq!(to_index.len(), 1);
        assert_eq!(
            to_index[0].title, "Destination Title",
            "destination's existing entry must win on an id conflict"
        );

        std::fs::remove_dir_all(&from).ok();
        std::fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn migrate_tolerates_a_missing_source_index() {
        // No index.json was ever written at `from` (e.g. the meetings
        // folder was populated some other way) -- load_index's
        // unwrap_or_default() path must not turn this into a hard failure.
        let from = temp_base("missing-index-from");
        let to = temp_base("missing-index-to");
        write_meeting_dir(&from, "a");

        let result =
            migrate_meetings(from.to_string_lossy().to_string(), to.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(to.join("meetings").join("a").join("summary.md").exists());

        std::fs::remove_dir_all(&from).ok();
        std::fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn migrate_tolerates_a_corrupt_source_index() {
        let from = temp_base("corrupt-index-from");
        let to = temp_base("corrupt-index-to");
        write_meeting_dir(&from, "a");
        std::fs::write(from.join("index.json"), "{ not valid json").expect("write corrupt index");

        let result =
            migrate_meetings(from.to_string_lossy().to_string(), to.to_string_lossy().to_string());
        assert!(result.is_ok());
        // The corrupt index had no readable entries, so nothing gets merged
        // into `to`'s index even though the directory itself still moved.
        let to_index = load_index(&to).expect("load to index");
        assert!(to_index.is_empty());

        std::fs::remove_dir_all(&from).ok();
        std::fs::remove_dir_all(&to).ok();
    }

    #[test]
    fn move_dir_falls_back_to_a_recursive_copy_when_rename_fails() {
        // A real EXDEV needs a second actual filesystem/mount, which isn't
        // available in a unit test. This forces `fs::rename` to fail a
        // different way instead (a destination whose parent directory
        // doesn't exist yet, so rename returns ENOENT) to exercise the
        // exact same fallback branch `move_dir` takes on EXDEV.
        let src_base = temp_base("fallback-src");
        let dest_base = temp_base("fallback-dest");
        std::fs::remove_dir_all(&dest_base).ok(); // dest parent must not exist yet

        let src = src_base.join("meeting");
        std::fs::create_dir_all(src.join("nested")).expect("create nested src dir");
        std::fs::write(src.join("summary.md"), "hello").expect("write file");
        std::fs::write(src.join("nested").join("notes.txt"), "nested").expect("write nested file");

        let dest = dest_base.join("meetings").join("meeting");
        move_dir(&src, &dest).expect("move_dir should fall back to copy+remove");

        assert!(!src.exists(), "source must be removed after a successful fallback move");
        assert_eq!(
            std::fs::read_to_string(dest.join("summary.md")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("nested").join("notes.txt")).unwrap(),
            "nested"
        );

        std::fs::remove_dir_all(&src_base).ok();
        std::fs::remove_dir_all(&dest_base).ok();
    }

    #[test]
    fn migrate_records_per_directory_failures_without_aborting_the_rest() {
        // Simulates one meeting directory that cannot be moved (its
        // destination path is occupied by a file, not a directory, so both
        // the rename and the copy-then-remove fallback fail) alongside one
        // that can. The good one must still end up moved and indexed at
        // `to`, and the bad one must stay fully represented at `from`
        // (finding #2: no partial failure may leave a meeting unlisted
        // anywhere).
        let from = temp_base("partial-fail-from");
        let to = temp_base("partial-fail-to");

        write_meeting_dir(&from, "good");
        write_meeting_dir(&from, "bad");
        write_index(&from, &[meta("good", "Good"), meta("bad", "Bad")]);

        // Block "bad"'s destination: create its parent, then occupy the
        // exact destination path with a plain file so neither rename nor
        // create_dir_all/copy can succeed there.
        std::fs::create_dir_all(to.join("meetings")).expect("create to/meetings");
        std::fs::write(to.join("meetings").join("bad"), "occupied").expect("occupy destination");

        let result =
            migrate_meetings(from.to_string_lossy().to_string(), to.to_string_lossy().to_string());
        assert!(result.is_err(), "a per-directory failure must be reported");

        let to_index = load_index(&to).expect("load to index");
        assert!(to_index.iter().any(|m| m.id == "good"), "the meeting that moved must be indexed at `to`");
        assert!(!to_index.iter().any(|m| m.id == "bad"), "the meeting that failed to move must not be indexed at `to`");

        let from_index = load_index(&from).expect("load from index");
        assert!(!from_index.iter().any(|m| m.id == "good"), "the moved meeting must be dropped from `from`'s index");
        assert!(from_index.iter().any(|m| m.id == "bad"), "the meeting that failed to move must stay listed at `from`");
        assert!(from.join("meetings").join("bad").exists(), "the meeting that failed to move must still have its files at `from`");

        std::fs::remove_dir_all(&from).ok();
        std::fs::remove_dir_all(&to).ok();
    }
}
