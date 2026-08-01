// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Native Wayland doesn't let clients control their own stacking order, so
    // GTK's always-on-top hint is silently ignored there. Forcing XWayland
    // makes it work, since X11 window managers do honor the hint.
    if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland") {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    meeting_notes_lib::run()
}
