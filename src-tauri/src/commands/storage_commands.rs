use crate::commands::resolved_base_dir;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus, MeetingType};
use meeting_notes_storage::{append_to_index, create_meeting, find_orphaned_meetings, set_meeting_status};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

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
pub fn update_meeting_status(
    meeting_id: String,
    status: MeetingStatus,
    duration_seconds: Option<u64>,
    used_system_audio: Option<bool>,
) -> Result<(), String> {
    let base = resolved_base_dir()?;
    set_meeting_status(&base, &meeting_id, status, duration_seconds, used_system_audio)
        .map_err(|e| e.to_string())
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

/// Opens a meeting's `summary.md` in the system's default handler.
///
/// Deliberately calls `AppHandle::opener()` directly instead of having the
/// frontend invoke the opener plugin's own `open_path` command: that
/// command is gated by the `opener:allow-open-path` capability, whose scope
/// is static ACL configuration resolved at build/startup and can't be
/// extended to "wherever the user's configured data directory happens to
/// be" at runtime (checked the `tauri-plugin-opener` 2.5.4 API -- `Scope`
/// only exposes read-only `is_path_allowed`/`is_url_allowed`, no runtime
/// `allow`). Calling the plugin's own Rust API from a command we control
/// sidesteps that scope entirely, since the ACL check lives only in the
/// plugin's IPC command wrapper (see its `commands.rs`), not in
/// `Opener::open_path` itself. The path is built here from the
/// server-resolved base dir rather than trusted from the caller, so this
/// stays scoped to this app's own meeting files regardless of the
/// capabilities file.
#[tauri::command]
pub fn open_summary(app: AppHandle, meeting_id: String) -> Result<(), String> {
    // meeting_id is normally sourced from the on-disk index (see
    // MeetingMeta::id's doc comment: "directory name"), but it still
    // crosses the IPC boundary as a plain client-supplied string, so reject
    // anything that could escape the meetings directory.
    if meeting_id.is_empty() || meeting_id.contains('/') || meeting_id.contains("..") {
        return Err(format!("invalid meeting id: {meeting_id}"));
    }
    let base = resolved_base_dir()?;
    let summary_path = base.join("meetings").join(&meeting_id).join("summary.md");
    app.opener()
        .open_path(summary_path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
