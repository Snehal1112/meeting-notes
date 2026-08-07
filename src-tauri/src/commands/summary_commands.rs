use crate::commands::resolved_base_dir;
use meeting_notes_core::config::resolve_config;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_core::notes_markdown::render_summary_markdown;
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use meeting_notes_storage::{load_index, update_meeting};
use meeting_notes_summary::{build_provider, build_provider_for_kind, notes::generate_notes, ProviderKind};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn summarize_meeting(
    app: AppHandle,
    meeting_id: String,
    provider_override: Option<ProviderKind>,
) -> Result<SummaryResult, String> {
    let base = resolved_base_dir()?;
    let meeting = find_meeting(&base, &meeting_id)?;

    // "No provider configured" is a distinct, benign, recoverable state per
    // the design spec (transcript stays valid; summary shows as "Not
    // generated") — not a failure. Check for it and return early, before
    // entering run_summarize_or_mark_failed's failure-marking wrapper, so
    // this error path never touches the meeting's status in the index.
    let config = resolve_config();
    let provider = match provider_override {
        // An explicit override (e.g. "regenerate with the other provider")
        // bypasses select_provider_kind's auto-selection entirely, but must
        // still fail the same benign way if that specific provider turns out
        // to be unconfigured.
        Some(kind) => build_provider_for_kind(&config, kind)
            .ok_or_else(|| format!("{kind:?} is not configured"))?,
        None => match build_provider(&config) {
            Some(provider) => provider,
            None => return Err("not_configured".to_string()),
        },
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
            mark_meeting_failed(base, meeting, &e);
            Err(e)
        }
    }
}

/// Reads the transcript, generates the notes, writes the summary files, and
/// marks the meeting Done in the index. Returns the notes and the updated
/// meeting on success.
async fn run_summarize(
    base: &Path,
    meeting: MeetingMeta,
    provider: Box<dyn SummaryProvider + Send + Sync>,
) -> Result<(SummaryResult, MeetingMeta), String> {
    let meeting_dir = meeting.dir_path(base);
    let transcript = std::fs::read_to_string(meeting_dir.join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))?;

    let result = generate_notes(provider.as_ref(), meeting.meeting_type, &transcript).await?;

    write_summary_files(&meeting_dir, &result, &meeting)?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Done;
    update_meeting(base, &updated).map_err(|e| e.to_string())?;

    Ok((result, updated))
}

/// Best-effort marks `meeting` Failed in the index, recording `error` so
/// meeting history can show why. Logs to stderr (rather than propagating)
/// if even that write fails, since the caller already has a more relevant
/// error to report.
fn mark_meeting_failed(base: &Path, mut meeting: MeetingMeta, error: &str) {
    meeting.status = MeetingStatus::Failed;
    meeting.error_message = Some(error.to_string());
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

/// Writes `summary.md`, `action_items.json`, and `summary_result.json` into
/// the meeting's directory. `meeting` supplies the title, date and duration
/// that head the document, so those are never taken from the model.
/// `summary_result.json` is the raw structured `SummaryResult` — meeting
/// history (`history_commands.rs`) reads its `summary` field back out for a
/// row snippet, so this stays the single source of truth for that text
/// rather than re-deriving it from the rendered markdown.
fn write_summary_files(
    meeting_dir: &Path,
    result: &SummaryResult,
    meeting: &MeetingMeta,
) -> Result<(), String> {
    std::fs::write(
        meeting_dir.join("summary.md"),
        render_summary_markdown(result, meeting),
    )
    .map_err(|e| e.to_string())?;

    let action_items_json: Vec<serde_json::Value> = result
        .action_items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            serde_json::json!({
                "id": i.to_string(),
                "text": item.text,
                "owner": item.owner,
                "completed": false
            })
        })
        .collect();
    std::fs::write(
        meeting_dir.join("action_items.json"),
        serde_json::to_string_pretty(&action_items_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    std::fs::write(
        meeting_dir.join("summary_result.json"),
        serde_json::to_string_pretty(result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use meeting_notes_core::meeting::MeetingType;
    use meeting_notes_core::summary::{ActionItem, Topic};
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
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        let found = find_meeting(&base, &meeting.id).expect("meeting found");
        assert_eq!(found.id, meeting.id);
        assert_eq!(found.title, meeting.title);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn find_meeting_errors_when_id_not_in_index() {
        let base = temp_base("missing-id");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        let result = find_meeting(&base, "nonexistent-id");
        assert!(result.is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_summary_files_writes_the_rendered_notes_and_action_items() {
        let base = temp_base("writes-files");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        let meeting_dir = meeting.dir_path(&base);

        let result = SummaryResult {
            meeting_type: "Team sync".to_string(),
            attendees: vec!["Parker".to_string()],
            referenced_people: vec![],
            summary: "Discussed the roadmap.".to_string(),
            topics: vec![Topic {
                title: "Roadmap".to_string(),
                points: vec!["Shipping on Friday.".to_string()],
            }],
            decisions: vec!["Ship Friday.".to_string()],
            action_items: vec![ActionItem {
                text: "Send follow-up email".to_string(),
                owner: Some("Parker".to_string()),
            }],
            open_questions: vec!["Who writes the release note?".to_string()],
        };
        write_summary_files(&meeting_dir, &result, &meeting).expect("write summary files");

        let summary_md =
            std::fs::read_to_string(meeting_dir.join("summary.md")).expect("read summary.md");
        assert!(summary_md.contains("# Test meeting"));
        assert!(summary_md.contains("## Discussion Notes"));
        assert!(summary_md.contains("### Roadmap"));
        assert!(summary_md.contains("## Open Questions"));
        assert!(summary_md.contains("- [ ] Send follow-up email — Parker"));

        let action_items_json = std::fs::read_to_string(meeting_dir.join("action_items.json"))
            .expect("read action_items.json");
        assert!(action_items_json.contains("Send follow-up email"));
        assert!(action_items_json.contains("\"owner\": \"Parker\""));
        assert!(action_items_json.contains("\"completed\": false"));

        let summary_result_json =
            std::fs::read_to_string(meeting_dir.join("summary_result.json"))
                .expect("read summary_result.json");
        let round_tripped: SummaryResult =
            serde_json::from_str(&summary_result_json).expect("parse summary_result.json");
        assert_eq!(round_tripped.summary, "Discussed the roadmap.");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mark_meeting_failed_persists_failed_status_in_the_index() {
        let base = temp_base("marks-failed");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        mark_meeting_failed(&base, meeting.clone(), "provider returned malformed JSON");

        let index = load_index(&base).expect("load index");
        let persisted = index
            .iter()
            .find(|m| m.id == meeting.id)
            .expect("meeting present in index");
        assert_eq!(persisted.status, MeetingStatus::Failed);
        assert_eq!(
            persisted.error_message.as_deref(),
            Some("provider returned malformed JSON")
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mark_meeting_failed_does_not_panic_when_meeting_is_not_in_the_index() {
        // The meeting was never appended to index.json (e.g. a resolveable
        // base_dir but an index write that never happened) — update_meeting
        // returns an error, which must be logged, not panicked on.
        let base = temp_base("missing-from-index");
        let meeting = create_meeting(&base, "Untracked meeting", MeetingType::AutoDetect).expect("create meeting");

        mark_meeting_failed(&base, meeting, "some error");

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
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
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
