use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use std::path::{Path, PathBuf};

fn slugify(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    slug.trim_matches('-').chars().take(30).collect()
}

pub fn create_meeting(base: &Path, title: &str) -> std::io::Result<MeetingMeta> {
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
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

fn save_index(base: &Path, index: &[MeetingMeta]) -> std::io::Result<()> {
    let contents = serde_json::to_string_pretty(index)?;
    std::fs::write(index_path(base), contents)
}

pub fn append_to_index(base: &Path, meta: &MeetingMeta) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    index.push(meta.clone());
    save_index(base, &index)
}

pub fn update_meeting(base: &Path, updated: &MeetingMeta) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    if let Some(entry) = index.iter_mut().find(|m| m.id == updated.id) {
        *entry = updated.clone();
    }
    save_index(base, &index)
}

#[cfg(test)]
mod tests;
