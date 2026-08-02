use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MeetingStatus {
    Recording,
    Transcribing,
    Summarizing,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMeta {
    pub id: String, // directory name, e.g. "2026-08-01_143000_team-sync"
    pub title: String,
    pub created_at: String, // ISO 8601
    pub duration_seconds: Option<u64>,
    pub status: MeetingStatus,
    pub used_system_audio: bool,
}

impl MeetingMeta {
    pub fn dir_path(&self, base: &Path) -> PathBuf {
        base.join("meetings").join(&self.id)
    }
}
