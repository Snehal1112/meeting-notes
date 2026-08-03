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

/// The kind of meeting, chosen by the user before recording starts.
///
/// Distinct from `SummaryResult::meeting_type`, which is a free-text
/// descriptor the model infers from the transcript afterwards. This one is
/// the user's up-front intent and drives which prompt the summary crate uses.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum MeetingType {
    Standup,
    Retrospective,
    FeatureRequest,
    Incident,
    #[default]
    AutoDetect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMeta {
    pub id: String, // directory name, e.g. "2026-08-01_143000_team-sync"
    pub title: String,
    pub created_at: String, // ISO 8601
    pub duration_seconds: Option<u64>,
    pub status: MeetingStatus,
    pub used_system_audio: bool,
    /// Defaulted so meetings recorded before this field existed still
    /// deserialize — `load_index` treats any parse failure as fatal, which
    /// would otherwise make the whole on-disk index unreadable.
    #[serde(default)]
    pub meeting_type: MeetingType,
}

impl MeetingMeta {
    pub fn dir_path(&self, base: &Path) -> PathBuf {
        base.join("meetings").join(&self.id)
    }
}
