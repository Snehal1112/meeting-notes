use meeting_notes_core::config::{load_from_file, resolve_config, save_to_file, Config};

#[tauri::command]
pub fn get_config() -> Config {
    resolve_config()
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
