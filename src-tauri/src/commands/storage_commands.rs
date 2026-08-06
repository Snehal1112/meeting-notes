use crate::commands::resolved_base_dir;
use meeting_notes_core::meeting::{MeetingMeta, MeetingType};
use meeting_notes_storage::{append_to_index, create_meeting, find_orphaned_meetings, update_meeting};

#[tauri::command]
pub fn create_new_meeting(
    title: String,
    meeting_type: MeetingType,
) -> Result<MeetingMeta, String> {
    let base = resolved_base_dir()?;
    let meta = create_meeting(&base, &title, meeting_type).map_err(|e| e.to_string())?;
    append_to_index(&base, &meta).map_err(|e| e.to_string())?;
    Ok(meta)
}

#[tauri::command]
pub fn update_meeting_status(meeting: MeetingMeta) -> Result<(), String> {
    let base = resolved_base_dir()?;
    update_meeting(&base, &meeting).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_orphaned_meetings() -> Result<Vec<MeetingMeta>, String> {
    let base = resolved_base_dir()?;
    find_orphaned_meetings(&base).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_data_dir() -> Result<String, String> {
    let base = resolved_base_dir()?;
    Ok(base.to_string_lossy().to_string())
}
