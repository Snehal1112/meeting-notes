pub mod commands;

use commands::recording_commands::RecordingState;
use std::sync::Mutex;
use tauri::Manager;
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Auto-grants microphone access to the webview on Linux.
///
/// WebKitGTK denies every `WebKitUserMediaPermissionRequest` unless the host
/// application answers the `permission-request` signal, and wry's webkitgtk
/// backend never installs such a handler. Without this the waveform's
/// `getUserMedia()` call fails silently. Other permission kinds return `false`
/// so they keep WebKit's default behaviour.
#[cfg(target_os = "linux")]
fn allow_media_permissions(app: &tauri::AppHandle) {
    use webkit2gtk::glib::prelude::*;
    use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let result = window.with_webview(|webview| {
        webview.inner().connect_permission_request(|_, request| {
            if request.is::<UserMediaPermissionRequest>() {
                request.allow();
                true
            } else {
                false
            }
        });
    });
    if let Err(err) = result {
        eprintln!("failed to install webview permission handler: {err}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RecordingState(Mutex::new(None)))
        .manage(commands::window_commands::ClickThroughState::default())
        .manage(commands::mic_watcher_commands::MicWatcherPid::default())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            allow_media_permissions(app.handle());

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

            // Keeps the pill's click-through mask in sync with the window's
            // live size. Registered once here rather than re-applied by a
            // poll loop: `WindowEvent::Resized` already fires on every real
            // size change (including each frame of the pill's shrink/grow
            // animation), and this handler runs on the main thread as part
            // of the runtime's own event dispatch, so there is no extra
            // latency between the window's shape and its actual size.
            if let Some(window) = app.get_webview_window("main") {
                let click_through = app
                    .state::<commands::window_commands::ClickThroughState>()
                    .0
                    .clone();
                let resize_window = window.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Resized(_))
                        && click_through.load(std::sync::atomic::Ordering::SeqCst)
                    {
                        commands::window_commands::apply_click_through(&resize_window, true);
                    }
                });
            }

            commands::mic_watcher_commands::start_mic_watcher(app.handle());

            let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("failed to load tray icon");

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("Meeting Notes")
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::config_commands::get_config,
            commands::config_commands::get_raw_config,
            commands::config_commands::save_config,
            commands::config_commands::config_needs_setup,
            commands::config_commands::set_summary_provider,
            commands::config_commands::set_data_dir,
            commands::recording_commands::start_recording,
            commands::recording_commands::stop_recording,
            commands::storage_commands::create_new_meeting,
            commands::storage_commands::update_meeting_status,
            commands::storage_commands::get_orphaned_meetings,
            commands::storage_commands::get_data_dir,
            commands::storage_commands::open_summary,
            commands::transcription_commands::transcribe_meeting,
            commands::transcription_commands::read_transcript_text,
            commands::summary_commands::summarize_meeting,
            commands::data_dir_commands::count_meetings_at,
            commands::data_dir_commands::migrate_meetings,
            commands::window_commands::set_click_through_tracking,
            commands::history_commands::get_meeting_history,
            commands::history_commands::delete_meeting,
            commands::history_commands::reveal_in_file_manager
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // The `pactl subscribe` child spawned by start_mic_watcher has
            // no other shutdown hook -- Linux reparents (rather than kills)
            // a process's children when it exits, so without this it would
            // leak as an orphan on every app exit. Mirrors the pw-record
            // SIGTERM convention in crates/meeting-notes-audio/src/linux.rs.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let pid_state = app_handle.state::<commands::mic_watcher_commands::MicWatcherPid>();
                commands::mic_watcher_commands::stop_mic_watcher(&pid_state);
            }
        });
}
