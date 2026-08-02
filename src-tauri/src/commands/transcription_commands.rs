use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_storage::{base_dir, update_meeting};
use meeting_notes_transcription::{run_whisper, save_transcript};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn transcribe_meeting(
    app: AppHandle,
    meeting: MeetingMeta,
    whisper_model: String,
) -> Result<(), String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meeting_dir = meeting.dir_path(&base);
    let audio_path = meeting_dir.join("audio.wav");

    let meeting_clone = meeting.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_whisper(&audio_path, &whisper_model)
    })
    .await
    .map_err(|e| e.to_string())??;

    save_transcript(&meeting_dir, &result).map_err(|e| e.to_string())?;

    let mut updated = meeting_clone;
    updated.status = MeetingStatus::Summarizing;
    update_meeting(&base, &updated).map_err(|e| e.to_string())?;

    app.emit("transcription-complete", &updated)
        .map_err(|e| e.to_string())?;
    Ok(())
}
