use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use std::path::Path;

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

#[cfg(test)]
mod tests;
