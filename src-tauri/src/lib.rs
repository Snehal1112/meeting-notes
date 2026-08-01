pub mod commands;

use commands::recording_commands::RecordingState;
use std::sync::Mutex;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(RecordingState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::config_commands::get_config,
            commands::config_commands::save_config,
            commands::config_commands::config_needs_setup,
            commands::recording_commands::start_recording,
            commands::recording_commands::stop_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
