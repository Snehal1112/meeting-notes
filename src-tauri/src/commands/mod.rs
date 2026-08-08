pub mod config_commands;
pub mod data_dir_commands;
pub mod history_commands;
pub mod mic_watcher_commands;
pub mod recording_commands;
pub mod storage_commands;
pub mod summary_commands;
pub mod transcription_commands;
pub mod window_commands;

use meeting_notes_core::config::resolve_config;
use std::path::{Path, PathBuf};

/// Resolves the configured data directory, honoring the user's `data_dir`
/// override when set. Shared by every command that touches meeting storage,
/// so the override lookup lives in one place.
pub(crate) fn resolved_base_dir() -> Result<PathBuf, String> {
    let config = resolve_config();
    meeting_notes_storage::base_dir(config.data_dir.as_deref().map(Path::new))
        .ok_or_else(|| "could not resolve data directory".to_string())
}
