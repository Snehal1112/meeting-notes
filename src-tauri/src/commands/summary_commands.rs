use meeting_notes_core::config::resolve_config;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use meeting_notes_storage::{base_dir, load_index, update_meeting};
use meeting_notes_summary::claude::ClaudeProvider;
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn summarize_meeting(app: AppHandle, meeting_id: String) -> Result<SummaryResult, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meeting = find_meeting(&base, &meeting_id)?;

    let meeting_dir = meeting.dir_path(&base);
    let transcript = std::fs::read_to_string(meeting_dir.join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))?;

    let config = resolve_config();
    let Some(api_key) = config.claude_api_key else {
        return Err("no_provider_configured".to_string());
    };

    let provider = ClaudeProvider::new(api_key);
    let result = provider.generate(&transcript).await?;

    write_summary_files(&meeting_dir, &result)?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Done;
    update_meeting(&base, &updated).map_err(|e| e.to_string())?;
    app.emit("summary-complete", &updated)
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Loads the current meeting from the on-disk index by id, rather than
/// trusting a client-supplied `MeetingMeta`. A stale client-held copy would
/// silently revert other fields on the full-record `update_meeting` write
/// below — the exact bug pattern plan 08 hit — so the server always reloads
/// its own copy before mutating and persisting it.
fn find_meeting(base: &Path, meeting_id: &str) -> Result<MeetingMeta, String> {
    let index = load_index(base).map_err(|e| e.to_string())?;
    index
        .into_iter()
        .find(|m| m.id == meeting_id)
        .ok_or_else(|| format!("meeting {meeting_id} not found"))
}

/// Writes `summary.md` and `action_items.json` into the meeting's directory.
/// Split out from `summarize_meeting` so the AppHandle-free file-writing
/// logic can be unit tested directly.
fn write_summary_files(meeting_dir: &Path, result: &SummaryResult) -> Result<(), String> {
    std::fs::write(
        meeting_dir.join("summary.md"),
        format!(
            "{}\n\n## Action Items\n{}",
            result.summary,
            result
                .action_items
                .iter()
                .map(|i| format!("- [ ] {i}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .map_err(|e| e.to_string())?;

    let action_items_json: Vec<serde_json::Value> = result
        .action_items
        .iter()
        .enumerate()
        .map(|(i, text)| serde_json::json!({ "id": i.to_string(), "text": text, "completed": false }))
        .collect();
    std::fs::write(
        meeting_dir.join("action_items.json"),
        serde_json::to_string_pretty(&action_items_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use meeting_notes_storage::{append_to_index, create_meeting};
    use std::path::PathBuf;

    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "meeting-notes-summary-commands-test-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        std::fs::create_dir_all(&dir).expect("create temp base dir");
        dir
    }

    #[test]
    fn find_meeting_returns_the_matching_meeting_from_the_index() {
        let base = temp_base("finds-match");
        let meeting = create_meeting(&base, "Test meeting").expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        let found = find_meeting(&base, &meeting.id).expect("meeting found");
        assert_eq!(found.id, meeting.id);
        assert_eq!(found.title, meeting.title);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn find_meeting_errors_when_id_not_in_index() {
        let base = temp_base("missing-id");
        let meeting = create_meeting(&base, "Test meeting").expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        let result = find_meeting(&base, "nonexistent-id");
        assert!(result.is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_summary_files_writes_summary_and_action_items() {
        let base = temp_base("writes-files");
        let meeting = create_meeting(&base, "Test meeting").expect("create meeting");
        let meeting_dir = meeting.dir_path(&base);

        let result = SummaryResult {
            summary: "Discussed the roadmap.".to_string(),
            action_items: vec!["Send follow-up email".to_string()],
        };
        write_summary_files(&meeting_dir, &result).expect("write summary files");

        let summary_md =
            std::fs::read_to_string(meeting_dir.join("summary.md")).expect("read summary.md");
        assert!(summary_md.contains("Discussed the roadmap."));
        assert!(summary_md.contains("- [ ] Send follow-up email"));

        let action_items_json = std::fs::read_to_string(meeting_dir.join("action_items.json"))
            .expect("read action_items.json");
        assert!(action_items_json.contains("Send follow-up email"));
        assert!(action_items_json.contains("\"completed\": false"));

        std::fs::remove_dir_all(&base).ok();
    }
}
