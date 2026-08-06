import { getCurrentWindow } from "@tauri-apps/api/window";

interface DragMouseEvent {
  button: number;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}

interface StartWindowDragOptions {
  /// Only start a drag when the mousedown landed on the drag surface itself.
  /// Needed for surfaces that contain their own interactive children (the
  /// Recording and Processing pills hold a Stop button and a Retry button,
  /// the TitleBar holds a close button): mousedown bubbles, so without this
  /// guard pressing any of them would be swallowed into a window drag
  /// instead of reaching the control. A surface with only decorative
  /// children (no buttons or other interactive elements) can safely leave
  /// this off.
  requireSelfTarget?: boolean;
}

/// Starts a native window drag from a mousedown handler.
///
/// WebKitGTK's support for Tauri's native `data-tauri-drag-region` attribute is
/// unreliable on Linux, which is this project's primary (currently only)
/// platform, so every drag surface keeps `data-tauri-drag-region` for the
/// platforms where it works and calls this as a fallback for the ones where it
/// does not. Failures are logged rather than thrown: outside a real Tauri
/// runtime (jsdom in tests) there is no window to drag, and that must not
/// break rendering.
export function startWindowDrag(e: DragMouseEvent, options: StartWindowDragOptions = {}) {
  if (e.button !== 0) return;
  if (options.requireSelfTarget && e.target !== e.currentTarget) return;
  try {
    void getCurrentWindow()
      .startDragging()
      .catch((err) => console.error("startWindowDrag: startDragging failed", err));
  } catch (err) {
    console.error("startWindowDrag: no window to drag", err);
  }
}
