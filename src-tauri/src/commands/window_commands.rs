use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// Generation counter for the click-through poll thread. Bumped on every
/// start/stop call so a stale thread from a superseded call stops touching
/// the window instead of fighting a newer one -- mirrors the frontend's
/// own resizeRunRef/summarizeRunRef pattern in App.tsx/RecorderWidget.tsx.
#[derive(Default)]
pub struct ClickThroughState(pub Arc<AtomicU64>);

const POLL_INTERVAL: Duration = Duration::from_millis(50);

// Plain AppHandle (not generic over Runtime), matching the convention
// already used by summarize_meeting/transcribe_meeting in this codebase.
#[tauri::command]
pub fn set_click_through_tracking(
    app: AppHandle,
    state: State<ClickThroughState>,
    active: bool,
) -> Result<(), String> {
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };
    if !active {
        // Bumping the generation above stops the poll thread from taking
        // further action, but does not itself touch the ignore flag --
        // without this explicit reset, a stop that lands mid-"ignoring"
        // (cursor was over a transparent corner when Recording/Processing
        // ended) would leave the window permanently non-interactive.
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let generation_counter = state.0.clone();
    std::thread::spawn(move || {
        let mut ignoring = false;
        let mut logged_error = false;
        loop {
            std::thread::sleep(POLL_INTERVAL);
            if generation_counter.load(Ordering::SeqCst) != generation {
                // A newer call superseded this thread. Clear anything a tick that raced
                // the stop path may have set, so the window can never be left ignoring
                // cursor events.
                if ignoring {
                    let _ = window.set_ignore_cursor_events(false);
                }
                return;
            }
            let pos_result = window.inner_position();
            let size_result = window.inner_size();
            let cursor_result = window.cursor_position();
            let (Ok(pos), Ok(size), Ok(cursor)) = (&pos_result, &size_result, &cursor_result)
            else {
                // Unsupported or erroring window queries would otherwise make this loop
                // no-op forever with zero output. Log once per activation so a broken
                // API is distinguishable from a geometry miss during manual verification.
                if !logged_error {
                    eprintln!(
                        "click-through poll: window query failed (position: {pos_result:?}, size: {size_result:?}, cursor: {cursor_result:?})"
                    );
                    logged_error = true;
                }
                continue;
            };
            let relative = (cursor.x - pos.x as f64, cursor.y - pos.y as f64);
            let dims = (size.width as f64, size.height as f64);
            let should_ignore = !is_inside_pill(relative, dims);
            if should_ignore != ignoring && window.set_ignore_cursor_events(should_ignore).is_ok()
            {
                ignoring = should_ignore;
            }
        }
    });
    Ok(())
}

/// True if `point` (window-relative, physical pixels) lies within the
/// stadium shape a `rounded-full` pill of `size` renders as. Radius is
/// always half the height, matching the CSS exactly with no separate value
/// to keep in sync.
fn is_inside_pill(point: (f64, f64), size: (f64, f64)) -> bool {
    let (x, y) = point;
    let (width, height) = size;
    if x < 0.0 || y < 0.0 || x > width || y > height {
        return false;
    }
    let radius = height / 2.0;
    if x >= radius && x <= width - radius {
        return true;
    }
    let cap_center_x = if x < radius { radius } else { width - radius };
    let dx = x - cap_center_x;
    let dy = y - radius;
    (dx * dx + dy * dy) <= radius * radius
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORDING_PILL: (f64, f64) = (224.0, 56.0);

    #[test]
    fn inside_the_straight_middle_section() {
        assert!(is_inside_pill((112.0, 1.0), RECORDING_PILL));
    }

    #[test]
    fn inside_the_left_cap() {
        assert!(is_inside_pill((5.0, 28.0), RECORDING_PILL));
    }

    #[test]
    fn inside_the_right_cap() {
        assert!(is_inside_pill((219.0, 28.0), RECORDING_PILL));
    }

    #[test]
    fn outside_the_top_left_corner() {
        assert!(!is_inside_pill((1.0, 1.0), RECORDING_PILL));
    }

    #[test]
    fn outside_the_top_right_corner() {
        assert!(!is_inside_pill((223.0, 1.0), RECORDING_PILL));
    }

    #[test]
    fn outside_the_bottom_left_corner() {
        assert!(!is_inside_pill((1.0, 55.0), RECORDING_PILL));
    }

    #[test]
    fn outside_the_window_bounds_entirely() {
        assert!(!is_inside_pill((-5.0, 10.0), RECORDING_PILL));
        assert!(!is_inside_pill((300.0, 10.0), RECORDING_PILL));
    }
}
