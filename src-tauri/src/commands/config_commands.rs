use meeting_notes_core::config::{resolve_config, save_to_file, Config};

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
