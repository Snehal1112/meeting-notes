use crate::commands::resolved_base_dir;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_storage::{delete_meeting as delete_meeting_impl, extract_summary_snippet, load_index};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// One row's worth of data for the meeting history list. `meta` supplies
/// title/date/duration/type/status/error_message directly (flattened into
/// this struct's JSON); `snippet` is the one thing it doesn't carry, read
/// from the meeting's persisted `summary_result.json`.
#[derive(Debug, Serialize)]
pub struct MeetingHistoryEntry {
    #[serde(flatten)]
    pub meta: MeetingMeta,
    pub snippet: Option<String>,
}

/// Returns every meeting in the index with enough data to render a full
/// history row. Filtering, search, and pagination all happen client-side
/// (see the design spec) — a personal local recording app's meeting count
/// stays in the tens-to-low-hundreds, nowhere near enough to need a
/// server-side query API.
#[tauri::command]
pub fn get_meeting_history() -> Result<Vec<MeetingHistoryEntry>, String> {
    let base = resolved_base_dir()?;
    let index = load_index(&base).map_err(|e| e.to_string())?;

    let entries = index
        .into_iter()
        .map(|meta| {
            let snippet = if meta.status == MeetingStatus::Done {
                extract_summary_snippet(&meta.dir_path(&base), 80)
            } else {
                None
            };
            MeetingHistoryEntry { meta, snippet }
        })
        .collect();

    Ok(entries)
}

/// Deletes a meeting's directory and index entry. Errors if the meeting id
/// isn't found, rather than silently succeeding.
#[tauri::command]
pub fn delete_meeting(meeting_id: String) -> Result<(), String> {
    let base = resolved_base_dir()?;
    delete_meeting_impl(&base, &meeting_id).map_err(|e| e.to_string())
}

/// Opens the meeting's directory in the OS file manager. `meeting_id` is
/// looked up in the on-disk index rather than trusted directly -- like
/// `storage_commands::open_summary`, this keeps the revealed path scoped to
/// an id the server itself generated (`create_meeting`), not an arbitrary
/// client-supplied path, and calls `AppHandle::opener()` directly rather
/// than routing through the opener plugin's own IPC command (whose
/// `allow-open-path` scope is static ACL config, not something we can
/// widen at runtime to "wherever the user's configured data directory
/// happens to be" -- see `open_summary`'s doc comment for the full
/// reasoning).
#[tauri::command]
pub fn reveal_in_file_manager(app: AppHandle, meeting_id: String) -> Result<(), String> {
    let base = resolved_base_dir()?;
    let index = load_index(&base).map_err(|e| e.to_string())?;
    let meta = index
        .iter()
        .find(|m| m.id == meeting_id)
        .ok_or_else(|| format!("meeting {meeting_id} not found"))?;

    // The widget is unconditionally always-on-top (see lib.rs's `setup`), so
    // the file manager window this opens would otherwise render behind it
    // and look like nothing happened. Drop always-on-top before opening and
    // restore it on a delay -- mirroring `setup`'s own delayed-apply
    // pattern -- so the newly opened window gets a real chance to land on
    // top before the widget reclaims that spot.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(false);
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        let inner_handle = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(window) = inner_handle.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }
        });
    });

    app.opener()
        .open_path(meta.dir_path(&base).to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use meeting_notes_core::meeting::MeetingType;
    use meeting_notes_storage::{append_to_index, create_meeting};
    use std::path::PathBuf;

    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "meeting-notes-history-commands-test-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        std::fs::create_dir_all(&dir).expect("create temp base dir");
        dir
    }

    fn history_entries(base: &std::path::Path) -> Vec<MeetingHistoryEntry> {
        let index = load_index(base).expect("load index");
        index
            .into_iter()
            .map(|meta| {
                let snippet = if meta.status == MeetingStatus::Done {
                    extract_summary_snippet(&meta.dir_path(base), 80)
                } else {
                    None
                };
                MeetingHistoryEntry { meta, snippet }
            })
            .collect()
    }

    #[test]
    fn includes_a_snippet_for_a_done_meeting_with_a_persisted_summary() {
        let base = temp_base("done-with-summary");
        let mut meeting =
            create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        meeting.status = MeetingStatus::Done;
        append_to_index(&base, &meeting).expect("append to index");
        std::fs::write(
            meeting.dir_path(&base).join("summary_result.json"),
            r#"{"summary": "Shipped the roadmap."}"#,
        )
        .expect("write summary_result.json");

        let entries = history_entries(&base);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].snippet.as_deref(), Some("Shipped the roadmap."));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn omits_snippet_for_a_failed_meeting_and_exposes_the_error_message() {
        let base = temp_base("failed-meeting");
        let mut meeting =
            create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        meeting.status = MeetingStatus::Failed;
        meeting.error_message = Some("whisper.cpp exited with status 1".to_string());
        append_to_index(&base, &meeting).expect("append to index");

        let entries = history_entries(&base);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].snippet, None);
        assert_eq!(
            entries[0].meta.error_message.as_deref(),
            Some("whisper.cpp exited with status 1")
        );

        std::fs::remove_dir_all(&base).ok();
    }
}
