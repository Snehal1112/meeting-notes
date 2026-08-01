use meeting_notes_audio::{RecordingError, RecordingHandle};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// App-managed state holding the in-progress recording, if any.
pub struct RecordingState(pub Mutex<Option<RecordingHandle>>);

#[derive(Serialize)]
pub struct StopRecordingResult {
    pub output_path: String,
    pub quality_warning: Option<String>,
}

#[tauri::command]
pub fn start_recording(state: State<RecordingState>, output_path: String) -> Result<(), String> {
    let path = PathBuf::from(output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let handle = RecordingHandle::start_mic(&path).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_recording(state: State<RecordingState>) -> Result<StopRecordingResult, String> {
    let mut guard = state.0.lock().unwrap();
    let mut handle = guard.take().ok_or("no active recording")?;
    let output_path = handle.output_path().to_string_lossy().to_string();
    match handle.stop() {
        Ok(()) => Ok(StopRecordingResult {
            output_path,
            quality_warning: None,
        }),
        // The (trimmed) WAV file was still written successfully here, so the
        // caller gets its path back with a warning rather than an error.
        Err(err @ RecordingError::LikelyMicFault { .. }) => Ok(StopRecordingResult {
            output_path,
            quality_warning: Some(err.to_string()),
        }),
        Err(err) => Err(err.to_string()),
    }
}
