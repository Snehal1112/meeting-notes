use meeting_notes_audio::mic_watcher::watch_mic_activity;
use tauri::{AppHandle, Emitter};

pub fn start_mic_watcher(app: &AppHandle) {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let _ = watch_mic_activity(move || {
            let _ = app_handle.emit("external-mic-activity", ());
        });
        // If watch_mic_activity ever returns (pactl not installed, process
        // died, etc.), this silently stops watching for the rest of the
        // session rather than crashing the app -- acceptable degradation
        // for a convenience feature, but worth a log line here in practice
        // so it's not a silent, undiagnosable feature loss.
    });
}
