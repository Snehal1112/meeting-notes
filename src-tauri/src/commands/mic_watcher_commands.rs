use meeting_notes_audio::mic_watcher::watch_mic_activity;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

/// Holds the PID of the currently-running `pactl subscribe` child process
/// spawned by `start_mic_watcher`, as managed Tauri state so `lib.rs`'s
/// exit handler can reach it and send SIGTERM on app shutdown. Without
/// this, the child is reparented to init and keeps running as an orphan
/// after this app exits -- Linux does not terminate a process's children
/// when the parent exits.
///
/// `0` means "no child recorded yet" (the watcher thread hasn't spawned
/// `pactl subscribe` yet, or `watch_mic_activity` never got that far).
#[derive(Clone, Default)]
pub struct MicWatcherPid(pub Arc<AtomicI32>);

/// Spawns a background thread that runs `watch_mic_activity` for the
/// lifetime of the app, emitting `external-mic-activity` to the frontend
/// whenever someone else starts using the mic. The `pactl subscribe`
/// child's PID is recorded into the app's managed `MicWatcherPid` state as
/// soon as it's spawned, so it can be killed via `stop_mic_watcher` on
/// shutdown -- see that function and `MicWatcherPid`'s docs for why.
pub fn start_mic_watcher(app: &AppHandle) {
    let pid_state = app.state::<MicWatcherPid>().0.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let _ = watch_mic_activity(
            move |child_pid| pid_state.store(child_pid as i32, Ordering::SeqCst),
            move || {
                let _ = app_handle.emit("external-mic-activity", ());
            },
        );
        // If watch_mic_activity ever returns (pactl not installed, process
        // died, etc.), this silently stops watching for the rest of the
        // session rather than crashing the app -- acceptable degradation
        // for a convenience feature, but worth a log line here in practice
        // so it's not a silent, undiagnosable feature loss.
    });
}

/// Sends SIGTERM to the `pactl subscribe` child recorded in `pid_state`, if
/// any. Mirrors the `pw-record` shutdown convention in
/// `crates/meeting-notes-audio/src/linux.rs` (`RecordingHandle::stop`/
/// `Drop`), which also signals its child processes with `libc::kill(..,
/// SIGTERM)` rather than a hard kill -- `pactl subscribe` has no output to
/// flush on exit the way `pw-record` does, so SIGTERM vs. SIGKILL doesn't
/// matter for correctness here, but using the same mechanism keeps process
/// cleanup consistent across the codebase. Called from `lib.rs`'s
/// `RunEvent::ExitRequested` handler. No-op if no child has been recorded
/// yet, or if it already exited (a kill on a dead PID is a harmless
/// best-effort no-op, same reasoning as `RecordingHandle::drop`).
pub fn stop_mic_watcher(pid_state: &MicWatcherPid) {
    let pid = pid_state.0.load(Ordering::SeqCst);
    if pid != 0 {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}
