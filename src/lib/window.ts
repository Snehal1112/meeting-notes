import { invoke } from "@tauri-apps/api/core";

// Toggles the background poll loop (src-tauri/src/commands/window_commands.rs)
// that makes the Recording/Processing pills' transparent corners
// click-through. A plain JS mousemove listener can't do this: once the
// window starts ignoring cursor events, it stops receiving webview mouse
// events entirely, so there would be no way to detect the cursor moving
// back over the visible pill. The Rust side polls the OS-level global
// cursor position instead, which keeps working regardless.
export const setClickThroughTracking = (active: boolean) =>
  invoke<void>("set_click_through_tracking", { active });
