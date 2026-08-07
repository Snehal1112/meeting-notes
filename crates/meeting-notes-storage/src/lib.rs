use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus, MeetingType};
use std::path::{Path, PathBuf};

/// Resolves the app's data directory (e.g. `~/.local/share/meeting-notes` on
/// Linux), or `override_dir` when the user has configured a custom location.
pub fn base_dir(override_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        return Some(dir.to_path_buf());
    }
    directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")
        .map(|dirs| dirs.data_dir().to_path_buf())
}

/// Reads the `summary` field out of `summary_result.json`
/// (`summary_commands.rs::write_summary_files`) and truncates to
/// `max_chars`, appending an ellipsis if truncated. Returns `None` if the
/// file doesn't exist yet (meeting still processing/failed before ever
/// reaching summarization) rather than erroring — the caller decides what
/// to show in that case.
pub fn extract_summary_snippet(meeting_dir: &Path, max_chars: usize) -> Option<String> {
    let contents = std::fs::read_to_string(meeting_dir.join("summary_result.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let summary = parsed.get("summary")?.as_str()?;

    if summary.chars().count() <= max_chars {
        Some(summary.to_string())
    } else {
        let truncated: String = summary.chars().take(max_chars).collect();
        Some(format!("{truncated}…"))
    }
}

/// Meetings whose status never advanced past Recording — likely crashed/interrupted.
pub fn find_orphaned_meetings(base: &Path) -> std::io::Result<Vec<MeetingMeta>> {
    let index = load_index(base)?;
    Ok(index
        .into_iter()
        .filter(|m| m.status == MeetingStatus::Recording)
        .collect())
}

fn slugify(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    slug.trim_matches('-').chars().take(30).collect()
}

pub fn create_meeting(
    base: &Path,
    title: &str,
    meeting_type: MeetingType,
) -> std::io::Result<MeetingMeta> {
    let now = chrono::Utc::now();
    let ts = now.format("%Y-%m-%d_%H%M%S").to_string();
    let slug = slugify(title);
    let id = if slug.is_empty() { ts.clone() } else { format!("{ts}_{slug}") };

    let meta = MeetingMeta {
        id,
        title: title.to_string(),
        created_at: now.to_rfc3339(),
        duration_seconds: None,
        status: MeetingStatus::Recording,
        used_system_audio: false,
        meeting_type,
        error_message: None,
    };

    std::fs::create_dir_all(meta.dir_path(base))?;
    Ok(meta)
}

fn index_path(base: &Path) -> PathBuf {
    base.join("index.json")
}

pub fn load_index(base: &Path) -> std::io::Result<Vec<MeetingMeta>> {
    let path = index_path(base);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(path)?;
    serde_json::from_str(&contents)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Writes `index.json` atomically (temp file + rename). `pub` so callers
/// outside this crate that need to write a full index directly -- e.g.
/// `migrate_meetings`, which writes both the source and destination indices
/// during a storage-location move -- go through the same crash-safe path as
/// `append_to_index`/`update_meeting` instead of a plain `fs::write`.
pub fn save_index(base: &Path, index: &[MeetingMeta]) -> std::io::Result<()> {
    let contents = serde_json::to_string_pretty(index)?;
    // Write to a temp file and rename over the real path so a crash mid-write
    // can never leave index.json truncated or corrupt — rename is atomic on
    // the same filesystem.
    let tmp = base.join("index.json.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(tmp, index_path(base))
}

pub fn append_to_index(base: &Path, meta: &MeetingMeta) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    index.push(meta.clone());
    save_index(base, &index)
}

/// Removes a meeting's directory from disk and its entry from the index.
/// Errors if `meeting_id` isn't in the index, rather than silently no-op-ing
/// — the caller (a user-triggered delete) should see that as a real
/// failure, not success.
pub fn delete_meeting(base: &Path, meeting_id: &str) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    let Some(pos) = index.iter().position(|m| m.id == meeting_id) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "meeting not found",
        ));
    };
    let meta = index.remove(pos);

    let meeting_dir = meta.dir_path(base);
    if meeting_dir.exists() {
        std::fs::remove_dir_all(&meeting_dir)?;
    }

    save_index(base, &index)
}

pub fn update_meeting(base: &Path, updated: &MeetingMeta) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    match index.iter_mut().find(|m| m.id == updated.id) {
        Some(entry) => *entry = updated.clone(),
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("meeting {} not found in index", updated.id),
            ));
        }
    }
    save_index(base, &index)
}

#[cfg(test)]
mod tests;
