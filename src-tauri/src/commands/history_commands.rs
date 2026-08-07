use crate::commands::resolved_base_dir;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_storage::{delete_meeting as delete_meeting_impl, extract_summary_snippet, load_index};
use serde::Serialize;

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
