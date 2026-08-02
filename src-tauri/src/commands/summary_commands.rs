use meeting_notes_core::config::resolve_config;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use meeting_notes_storage::{base_dir, load_index, update_meeting};
use meeting_notes_summary::build_provider;
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn summarize_meeting(app: AppHandle, meeting_id: String) -> Result<SummaryResult, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meeting = find_meeting(&base, &meeting_id)?;

    // "No provider configured" is a distinct, benign, recoverable state per
    // the design spec (transcript stays valid; summary shows as "Not
    // generated") — not a failure. Check for it and return early, before
    // entering run_summarize_or_mark_failed's failure-marking wrapper, so
    // this error path never touches the meeting's status in the index.
    let config = resolve_config();
    let Some(provider) = build_provider(&config) else {
        return Err("not_configured".to_string());
    };

    let (result, updated) = run_summarize_or_mark_failed(&base, meeting, provider).await?;
    app.emit("summary-complete", &updated)
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Runs the summarize flow and, if any step fails, best-effort marks the
/// meeting Failed in the index before returning the original error. Split
/// out from `summarize_meeting` so this AppHandle-free control flow can be
/// unit tested without a running Tauri app.
async fn run_summarize_or_mark_failed(
    base: &Path,
    meeting: MeetingMeta,
    provider: Box<dyn SummaryProvider + Send + Sync>,
) -> Result<(SummaryResult, MeetingMeta), String> {
    match run_summarize(base, meeting.clone(), provider).await {
        Ok(ok) => Ok(ok),
        Err(e) => {
            // Don't leave the meeting stuck at "Summarizing" forever if the
            // transcript read, the provider call, a file write, or the
            // index update itself failed — best-effort mark it Failed
            // instead. Mirrors the fire-and-log pattern already used in
            // transcription_commands.rs's transcribe_meeting: a failure here
            // must not mask the original error returned to the caller.
            mark_meeting_failed(base, meeting);
            Err(e)
        }
    }
}

/// Reads the transcript, calls the selected provider, writes the summary
/// files, and marks the meeting Done in the index. Returns the summary
/// result and the updated meeting on success.
async fn run_summarize(
    base: &Path,
    meeting: MeetingMeta,
    provider: Box<dyn SummaryProvider + Send + Sync>,
) -> Result<(SummaryResult, MeetingMeta), String> {
    let meeting_dir = meeting.dir_path(base);
    let transcript = std::fs::read_to_string(meeting_dir.join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))?;

    let result = provider.generate(&transcript).await?;

    write_summary_files(&meeting_dir, &result)?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Done;
    update_meeting(base, &updated).map_err(|e| e.to_string())?;

    Ok((result, updated))
}

/// Best-effort marks `meeting` Failed in the index. Logs to stderr (rather
/// than propagating) if even that write fails, since the caller already has
/// a more relevant error to report.
fn mark_meeting_failed(base: &Path, mut meeting: MeetingMeta) {
    meeting.status = MeetingStatus::Failed;
    if let Err(e) = update_meeting(base, &meeting) {
        eprintln!(
            "failed to mark meeting {} as Failed after a summarize error: {e}",
            meeting.id
        );
    }
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
    use meeting_notes_summary::claude::ClaudeProvider;
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

    #[test]
    fn mark_meeting_failed_persists_failed_status_in_the_index() {
        let base = temp_base("marks-failed");
        let meeting = create_meeting(&base, "Test meeting").expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        mark_meeting_failed(&base, meeting.clone());

        let index = load_index(&base).expect("load index");
        let persisted = index
            .iter()
            .find(|m| m.id == meeting.id)
            .expect("meeting present in index");
        assert_eq!(persisted.status, MeetingStatus::Failed);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mark_meeting_failed_does_not_panic_when_meeting_is_not_in_the_index() {
        // The meeting was never appended to index.json (e.g. a resolveable
        // base_dir but an index write that never happened) — update_meeting
        // returns an error, which must be logged, not panicked on.
        let base = temp_base("missing-from-index");
        let meeting = create_meeting(&base, "Untracked meeting").expect("create meeting");

        mark_meeting_failed(&base, meeting);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn run_summarize_or_mark_failed_marks_the_meeting_failed_in_the_index_on_error() {
        // No transcript.txt was ever written for this meeting (e.g. the
        // transcription step never completed), so run_summarize's read
        // fails before it ever reaches the network. This exercises the
        // exact function summarize_meeting calls, so it proves the
        // catch-and-mark-failed wiring itself (not just its pieces in
        // isolation) — without needing a real provider or an AppHandle.
        let base = temp_base("run-summarize-fails");
        let meeting = create_meeting(&base, "Test meeting").expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        let result = tauri::async_runtime::block_on(run_summarize_or_mark_failed(
            &base,
            meeting.clone(),
            Box::new(ClaudeProvider::new("dummy-api-key".to_string())),
        ));
        assert!(result.is_err());

        let index = load_index(&base).expect("load index");
        let persisted = index
            .iter()
            .find(|m| m.id == meeting.id)
            .expect("meeting present in index");
        assert_eq!(persisted.status, MeetingStatus::Failed);

        std::fs::remove_dir_all(&base).ok();
    }
}
