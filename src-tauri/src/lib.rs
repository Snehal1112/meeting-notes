pub mod commands;

use commands::recording_commands::RecordingState;
use std::sync::Mutex;
use tauri::Manager;

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
        .setup(|app| {
            // Requesting always-on-top together with transparent at window
            // creation trips a Mutter stacking-position bug on some Linux
            // setups, leaving the window painted blank. Setting it after
            // the first paint avoids the race.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let inner_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(window) = inner_handle.get_webview_window("main") {
                        let _ = window.set_always_on_top(true);
                    }
                });
            });
            Ok(())
        })
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
