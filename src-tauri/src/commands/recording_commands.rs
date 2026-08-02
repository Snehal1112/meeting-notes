use meeting_notes_audio::RecordingHandle;
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

#[tauri::command(async)]
pub fn start_recording(state: State<RecordingState>, output_path: String) -> Result<bool, String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Err("a recording is already in progress".to_string());
    }
    let path = PathBuf::from(output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let (handle, used_system_audio) = RecordingHandle::start(&path).map_err(|e| e.to_string())?;
    *guard = Some(handle);
    Ok(used_system_audio)
}

#[tauri::command(async)]
pub fn stop_recording(state: State<RecordingState>) -> Result<StopRecordingResult, String> {
    let mut guard = state.0.lock().unwrap();
    let mut handle = guard.take().ok_or("no active recording")?;
    let output_path = handle.output_path().to_string_lossy().to_string();
    let warning = handle.stop().map_err(|e| e.to_string())?;
    Ok(StopRecordingResult {
        output_path,
        quality_warning: warning.map(|w| w.to_string()),
    })
}
