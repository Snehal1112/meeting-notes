use meeting_notes_storage::load_index;
use std::path::PathBuf;

#[tauri::command]
pub fn count_meetings_at(path: String) -> Result<usize, String> {
    let dir = PathBuf::from(path);
    if !dir.exists() {
        return Ok(0);
    }
    load_index(&dir).map(|index| index.len()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn migrate_meetings(from: String, to: String) -> Result<(), String> {
    let from_dir = PathBuf::from(&from).join("meetings");
    let to_dir = PathBuf::from(&to).join("meetings");
    std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;

    if from_dir.exists() {
        for entry in std::fs::read_dir(&from_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let dest = to_dir.join(entry.file_name());
            std::fs::rename(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }

    // Merge index.json entries (by id, keep-first) rather than overwriting —
    // the target location may already have its own meetings if the user is
    // switching back to a previously-used folder.
    let from_index = load_index(&PathBuf::from(&from)).unwrap_or_default();
    let mut to_index = load_index(&PathBuf::from(&to)).unwrap_or_default();
    for meeting in from_index {
        if !to_index.iter().any(|m| m.id == meeting.id) {
            to_index.push(meeting);
        }
    }
    std::fs::write(
        PathBuf::from(&to).join("index.json"),
        serde_json::to_string_pretty(&to_index).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
