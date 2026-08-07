use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// Whether the pill's click-through mask should currently be kept in sync
/// with the window's size. Read by the `Resized` handler registered once in
/// `lib.rs`'s `setup`, so a native resize while the pill is showing (e.g.
/// mid pill-shrink animation) reapplies the mask immediately -- see
/// `apply_click_through` for why a live mask replaced the original
/// poll-and-toggle design.
#[derive(Default)]
pub struct ClickThroughState(pub Arc<AtomicBool>);

/// Builds the input-shape region matching a `rounded-full` pill of `size`,
/// one physical-pixel row at a time -- the same stadium geometry the pill's
/// CSS renders (radius is always half the height). Handed to
/// `input_shape_combine_region`, this makes GTK do per-pixel input
/// hit-testing natively: pixels inside the stadium receive clicks, pixels
/// in the pill's transparent corners pass them through to whatever is
/// behind the window. Because the OS does this hit-testing itself, no
/// runtime polling or cursor tracking is needed once the shape is set.
#[cfg(target_os = "linux")]
fn stadium_region(size: (f64, f64)) -> cairo::Region {
    let (width, height) = size;
    let radius = height / 2.0;
    let row_count = height.round().max(0.0) as i32;
    let rects: Vec<cairo::RectangleInt> = (0..row_count)
        .map(|row| {
            let y = row as f64 + 0.5;
            let dy = y - radius;
            let (left, right) = if dy.abs() >= radius {
                (radius, radius)
            } else {
                let dx = (radius * radius - dy * dy).sqrt();
                (radius - dx, width - radius + dx)
            };
            let left = left.floor().max(0.0) as i32;
            let right = right.ceil().min(width) as i32;
            cairo::RectangleInt::new(left, row, (right - left).max(0), 1)
        })
        .collect();
    cairo::Region::create_rectangles(&rects)
}

/// Applies or clears the pill's click-through mask for the window's current
/// size. Called directly from `set_click_through_tracking` (dispatched onto
/// the main thread, since `gtk_window()` requires it) and from the
/// `Resized` event handler in `lib.rs` (which already runs on the main
/// thread as part of the runtime's own event dispatch).
#[cfg(target_os = "linux")]
pub fn apply_click_through(window: &WebviewWindow, active: bool) {
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    if !active {
        gtk::prelude::WidgetExt::input_shape_combine_region(&gtk_window, None);
        return;
    }
    let Ok(size) = window.inner_size() else {
        return;
    };
    let region = stadium_region((size.width as f64, size.height as f64));
    gtk::prelude::WidgetExt::input_shape_combine_region(&gtk_window, Some(&region));
}

/// No per-pixel input-shaping API is wired up for other platforms yet (this
/// project targets Linux only for now -- see plan
/// 2026-08-01-13-macos-toolchain-permissions.md for the tracked follow-up).
/// Leaving the window fully clickable here is the safe default: it loses
/// the transparent-corner click-through, but can never swallow a real
/// button press the way the old polling design did on Linux.
#[cfg(not(target_os = "linux"))]
pub fn apply_click_through(_window: &WebviewWindow, _active: bool) {}

#[tauri::command]
pub fn set_click_through_tracking(
    app: AppHandle,
    state: State<ClickThroughState>,
    active: bool,
) -> Result<(), String> {
    state.0.store(active, Ordering::SeqCst);
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };
    app.run_on_main_thread(move || apply_click_through(&window, active))
        .map_err(|e| e.to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    const RECORDING_PILL: (f64, f64) = (224.0, 56.0);

    #[test]
    fn contains_the_straight_middle_section() {
        assert!(stadium_region(RECORDING_PILL).contains_point(112, 1));
    }

    #[test]
    fn contains_the_left_cap_center_row() {
        assert!(stadium_region(RECORDING_PILL).contains_point(1, 28));
    }

    #[test]
    fn contains_the_right_cap_center_row() {
        assert!(stadium_region(RECORDING_PILL).contains_point(222, 28));
    }

    #[test]
    fn excludes_the_top_left_corner() {
        assert!(!stadium_region(RECORDING_PILL).contains_point(0, 0));
    }

    #[test]
    fn excludes_the_top_right_corner() {
        assert!(!stadium_region(RECORDING_PILL).contains_point(223, 0));
    }

    #[test]
    fn excludes_the_bottom_left_corner() {
        assert!(!stadium_region(RECORDING_PILL).contains_point(0, 55));
    }

    #[test]
    fn excludes_points_outside_the_window_bounds() {
        let region = stadium_region(RECORDING_PILL);
        assert!(!region.contains_point(-5, 10));
        assert!(!region.contains_point(300, 10));
    }

    #[test]
    fn tracks_the_processing_pills_different_size() {
        let processing = stadium_region((280.0, 64.0));
        assert!(processing.contains_point(140, 1));
        assert!(!processing.contains_point(0, 0));
    }
}
