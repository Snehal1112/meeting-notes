use meeting_notes_core::config::{load_from_file, resolve_config, save_to_file, Config};

#[tauri::command]
pub fn get_config() -> Config {
    resolve_config()
}

/// Returns the raw persisted config, without environment values merged in.
///
/// `ConfigDialog` pre-fills its form from this instead of `get_config`: the
/// resolved config returned by `get_config` has environment values merged
/// in, so pre-filling from it would let an env-only secret (e.g.
/// `MEETING_NOTES_CLAUDE_API_KEY`) enter the form's state -- and from there,
/// round-trip right back out through Save into the plaintext config file,
/// even if the user only touched an unrelated field.
#[tauri::command]
pub fn get_raw_config() -> Config {
    load_from_file()
}

#[tauri::command]
pub fn save_config(config: Config) -> Result<(), String> {
    save_to_file(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_needs_setup() -> bool {
    let config = resolve_config();
    config.claude_api_key.is_none() && config.ollama_endpoint.is_none()
}

/// Persists only the summary provider choice.
///
/// Deliberately reads the file rather than the resolved config: `get_config`
/// returns environment values merged in, so writing that back would copy a
/// key the user only ever set in their environment into a plaintext file.
#[tauri::command]
pub fn set_summary_provider(provider: Option<String>) -> Result<(), String> {
    let mut config = load_from_file();
    config.summary_provider = provider;
    save_to_file(&config).map_err(|e| e.to_string())
}

/// Persists only the storage-location override, for the same reason
/// `set_summary_provider` reads from the file rather than the resolved
/// config.
///
/// Called immediately after a successful `migrate_meetings`, rather than
/// deferred to the settings panel's next Save click: a real filesystem move
/// has already happened by that point, and leaving `data_dir` unpersisted
/// until Save would strand the moved meetings if the user instead clicks
/// Skip, closes the panel, or the app crashes before saving.
#[tauri::command]
pub fn set_data_dir(data_dir: Option<String>) -> Result<(), String> {
    let mut config = load_from_file();
    config.data_dir = data_dir;
    save_to_file(&config).map_err(|e| e.to_string())
}
