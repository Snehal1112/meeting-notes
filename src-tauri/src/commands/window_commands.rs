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
/// CSS renders. A stadium's cap radius is always half its SHORTER
/// dimension; which pair of ends gets rounded depends on which dimension is
/// longer: wider-than-tall rounds the left/right ends (the Recording pill's
/// original horizontal shape), taller-than-wide rounds the top/bottom ends
/// instead (the vertical shape this function now also supports). The
/// vertical case is computed by running the horizontal-stadium math against
/// the transposed (height, width) dimensions, then transposing each
/// resulting rectangle back -- reusing proven geometry via a 90-degree
/// rotation rather than deriving a second closed-form independently.
/// Handed to `input_shape_combine_region`, this makes GTK do per-pixel
/// input hit-testing natively: pixels inside the stadium receive clicks,
/// pixels in the pill's transparent corners pass them through to whatever
/// is behind the window. Because the OS does this hit-testing itself, no
/// runtime polling or cursor tracking is needed once the shape is set.
#[cfg(target_os = "linux")]
fn stadium_region(size: (f64, f64)) -> cairo::Region {
    let (width, height) = size;
    if height > width {
        let transposed_rects = horizontal_stadium_rects((height, width));
        let rects: Vec<cairo::RectangleInt> = transposed_rects
            .into_iter()
            .map(|r| cairo::RectangleInt::new(r.y(), r.x(), r.height(), r.width()))
            .collect();
        cairo::Region::create_rectangles(&rects)
    } else {
        cairo::Region::create_rectangles(&horizontal_stadium_rects((width, height)))
    }
}

/// The original per-row stadium-rectangle computation (unchanged math),
/// factored out so `stadium_region` can share it between the horizontal
/// case and the transposed vertical case instead of duplicating it.
#[cfg(target_os = "linux")]
fn horizontal_stadium_rects(size: (f64, f64)) -> Vec<cairo::RectangleInt> {
    let (width, height) = size;
    let radius = height / 2.0;
    let row_count = height.round().max(0.0) as i32;
    (0..row_count)
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
        .collect()
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

    const VERTICAL_RECORDING_PILL: (f64, f64) = (60.0, 196.0); // this plan's new Recording pill size; radius = width / 2.0 = 30.0

    #[test]
    fn vertical_contains_the_straight_middle_section() {
        // Any x should be reachable at a y in the straight vertical band
        // between the two caps (roughly radius..height-radius) -- pick x=1
        // (near the left edge) and a y comfortably inside that band.
        assert!(stadium_region(VERTICAL_RECORDING_PILL).contains_point(1, 98));
    }

    #[test]
    fn vertical_contains_the_top_cap_center_row() {
        // The row through the top cap's own center (y = radius = 30) should
        // be reachable all the way to the horizontal edges (x near 0 and
        // x near width), since the cap's widest point is exactly there --
        // the same relationship the existing horizontal
        // contains_the_left_cap_center_row/contains_the_right_cap_center_row
        // tests check for the left/right caps, rotated 90 degrees.
        assert!(stadium_region(VERTICAL_RECORDING_PILL).contains_point(1, 30));
    }

    #[test]
    fn vertical_contains_the_bottom_cap_center_row() {
        // Mirrors the top-cap test for the bottom cap (y = height - radius = 166).
        assert!(stadium_region(VERTICAL_RECORDING_PILL).contains_point(58, 166));
    }

    #[test]
    fn vertical_excludes_all_four_corners() {
        let region = stadium_region(VERTICAL_RECORDING_PILL);
        assert!(!region.contains_point(0, 0));
        assert!(!region.contains_point(59, 0));
        assert!(!region.contains_point(0, 195));
        assert!(!region.contains_point(59, 195));
    }

    #[test]
    fn vertical_excludes_points_outside_the_window_bounds() {
        let region = stadium_region(VERTICAL_RECORDING_PILL);
        assert!(!region.contains_point(-5, 10));
        assert!(!region.contains_point(70, 10));
    }

    // No "processing pill" stadium-region test remains here on purpose: the
    // Processing state grew into a 340x220 rounded-2xl card (see App.tsx's
    // PILL_SIZES) and the frontend no longer requests this mask for it at
    // all (only Recording -- a true stadium/pill shape -- calls
    // setClickThroughTracking(true); see App.tsx's useStadiumMask). The old
    // test here asserted against stadium_region((280.0, 64.0)), a size the
    // app never uses for Processing even before this change (Processing was
    // already 340x220), and exercised a code path ("apply the stadium mask
    // to Processing") that no longer exists. Keeping it would have given
    // false confidence about a shape and call site nothing in the app still
    // produces. stadium_region itself remains fully covered above via
    // RECORDING_PILL, which is what's actually still in use.
}
