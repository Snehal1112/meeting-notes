use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_storage::{base_dir, update_meeting};
use meeting_notes_transcription::{run_whisper, save_transcript};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn transcribe_meeting(
    app: AppHandle,
    meeting: MeetingMeta,
    whisper_model: String,
) -> Result<(), String> {
    let base = base_dir().ok_or("could not resolve data directory")?;

    match run_transcription(&base, meeting.clone(), whisper_model).await {
        Ok(updated) => {
            app.emit("transcription-complete", &updated)
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            // Don't leave the meeting stuck at "Transcribing" forever if
            // whisper.cpp, the transcript write, or the index update itself
            // failed — best-effort mark it Failed instead. Mirrors the
            // fire-and-log pattern already used in RecorderWidget.tsx's
            // handleStart: a failure here must not mask the original error
            // returned to the caller.
            mark_meeting_failed(&base, meeting);
            Err(e)
        }
    }
}

/// Runs whisper.cpp on the meeting's audio, persists the transcript, and
/// marks the meeting Summarizing in the index. Returns the updated meeting
/// on success. Split out from `transcribe_meeting` so the AppHandle-free
/// failure-handling logic can be unit tested without a running Tauri app.
async fn run_transcription(
    base: &Path,
    meeting: MeetingMeta,
    whisper_model: String,
) -> Result<MeetingMeta, String> {
    let meeting_dir = meeting.dir_path(base);
    let audio_path = meeting_dir.join("audio.wav");

    let result = tauri::async_runtime::spawn_blocking(move || run_whisper(&audio_path, &whisper_model))
        .await
        .map_err(|e| e.to_string())??;

    save_transcript(&meeting_dir, &result).map_err(|e| e.to_string())?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Summarizing;
    update_meeting(base, &updated).map_err(|e| e.to_string())?;

    Ok(updated)
}

/// Best-effort marks `meeting` Failed in the index. Logs to stderr (rather
/// than propagating) if even that write fails, since the caller already has
/// a more relevant error to report.
fn mark_meeting_failed(base: &Path, mut meeting: MeetingMeta) {
    meeting.status = MeetingStatus::Failed;
    if let Err(e) = update_meeting(base, &meeting) {
        eprintln!(
            "failed to mark meeting {} as Failed after a transcription error: {e}",
            meeting.id
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meeting_notes_storage::{append_to_index, create_meeting, load_index};
    use std::path::PathBuf;

    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "meeting-notes-transcription-commands-test-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        std::fs::create_dir_all(&dir).expect("create temp base dir");
        dir
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
}
