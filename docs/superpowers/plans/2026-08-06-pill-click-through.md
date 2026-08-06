# Pill Click-Through Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Recording/Processing pills' transparent corners
click-through, so clicks that land there pass to whatever is behind the
window instead of being captured by it.

**Architecture:** A Rust-side background thread polls the OS-level global
cursor position (`Window::cursor_position()`, independent of this window's
own hit-testing state) at a fixed interval while a new
`set_click_through_tracking` command is active, and toggles
`Window::set_ignore_cursor_events` based on a pure geometry check against
the pill's stadium shape. The frontend calls this command whenever the
existing `isPill` boolean in `App.tsx` changes. All Tauri `Window` methods
used here go through the runtime's dispatcher (confirmed `Send + Sync +
'static` in the `tauri-runtime` crate), so they're safe to call from a
plain background thread without extra main-thread marshaling — this is
different from `lib.rs`'s existing `run_on_main_thread` usage, which exists
to work around a GTK stacking-order race, not a general thread-safety
requirement.

**Tech Stack:** Rust (Tauri 2, `std::thread` — no new crate dependencies),
React + TypeScript, Vitest.

## Global Constraints

- Comments end with a punctuation mark and use short, plain sentences.
- Code must build (`cargo check`, `tsc --noEmit`) and pass the full test
  suites (`cargo test`, `vitest run`) before commit.
- Ask the user for explicit go-ahead before any `git commit`.
- No new Cargo dependencies — `std::thread`/`std::sync::atomic` cover
  everything needed; do not add `tokio` as a direct dependency.

---

### Task 1: Rust click-through polling command

**Files:**
- Create: `src-tauri/src/commands/window_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: `#[tauri::command] set_click_through_tracking(active: bool) -> Result<(), String>`, registered in `lib.rs`'s `invoke_handler` — consumed by Task 2's frontend wrapper.

- [ ] **Step 1: Add the permission**

In `src-tauri/capabilities/default.json`, the current `permissions` array is:

```json
  "permissions": [
    "core:default",
    "opener:default",
    {
      "identifier": "opener:allow-open-path",
      "allow": [{ "path": "$HOME/.local/share/meeting-notes/**" }]
    },
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-current-monitor",
    "core:window:allow-close"
  ]
```

Add `"core:window:allow-set-ignore-cursor-events"` (plain string — verified
against `gen/schemas/desktop-schema.json`: "Enables the
set_ignore_cursor_events command without any pre-configured scope."):

```json
  "permissions": [
    "core:default",
    "opener:default",
    {
      "identifier": "opener:allow-open-path",
      "allow": [{ "path": "$HOME/.local/share/meeting-notes/**" }]
    },
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-current-monitor",
    "core:window:allow-close",
    "core:window:allow-set-ignore-cursor-events"
  ]
```

- [ ] **Step 2: Write the failing geometry unit tests**

Create `src-tauri/src/commands/window_commands.rs` with just the test
module — `is_inside_pill` does not exist yet, so this will not compile:

```rust
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test window_commands`
Expected: FAIL — compile error, `cannot find function `is_inside_pill` in this scope`.

- [ ] **Step 4: Implement `is_inside_pill`**

Add this above the `#[cfg(test)]` block:

```rust
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test window_commands`
Expected: PASS — 7 passed.

- [ ] **Step 6: Add the polling command**

Add this above `is_inside_pill` in the same file:

```rust
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
        loop {
            std::thread::sleep(POLL_INTERVAL);
            if generation_counter.load(Ordering::SeqCst) != generation {
                return;
            }
            let (Ok(pos), Ok(size), Ok(cursor)) = (
                window.inner_position(),
                window.inner_size(),
                window.cursor_position(),
            ) else {
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
```

- [ ] **Step 7: Register the module**

In `src-tauri/src/commands/mod.rs`, the current content is:

```rust
pub mod config_commands;
pub mod recording_commands;
pub mod storage_commands;
pub mod summary_commands;
pub mod transcription_commands;
```

Add the new module (keep alphabetical order):

```rust
pub mod config_commands;
pub mod recording_commands;
pub mod storage_commands;
pub mod summary_commands;
pub mod transcription_commands;
pub mod window_commands;
```

- [ ] **Step 8: Wire up managed state and the command in `lib.rs`**

In `src-tauri/src/lib.rs`, the current `Builder` chain is:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(RecordingState(Mutex::new(None)))
        .setup(|app| {
```

Add the new managed state:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(RecordingState(Mutex::new(None)))
        .manage(commands::window_commands::ClickThroughState::default())
        .setup(|app| {
```

And in the same file's `invoke_handler!` list, the current end of the list is:

```rust
            commands::transcription_commands::transcribe_meeting,
            commands::transcription_commands::read_transcript_text,
            commands::summary_commands::summarize_meeting
        ])
```

Add the new command:

```rust
            commands::transcription_commands::transcribe_meeting,
            commands::transcription_commands::read_transcript_text,
            commands::summary_commands::summarize_meeting,
            commands::window_commands::set_click_through_tracking
        ])
```

- [ ] **Step 9: Build and run the Rust test suite**

Run: `cd src-tauri && cargo check`
Expected: builds cleanly (this also validates the new capability entry
against the permission schema).

Run: `cd src-tauri && cargo test`
Expected: all tests pass, including the 7 new `window_commands` tests.

- [ ] **Step 10: Commit**

Ask the user for explicit go-ahead before running this.

```bash
git add src-tauri/src/commands/window_commands.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: add a Rust command to make the pill's transparent corners click-through"
```

---

### Task 2: Frontend wiring

**Files:**
- Create: `src/lib/window.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: `set_click_through_tracking(active: bool)` from Task 1.
- Produces: `setClickThroughTracking(active: boolean): Promise<void>` from `src/lib/window.ts` — consumed by `App.tsx`.

- [ ] **Step 1: Write the failing App.tsx test**

In `src/App.test.tsx`, add a mock for the new module near the top, next to
the existing `@/lib/config` and `@/lib/storage` mocks:

```tsx
vi.mock("@/lib/config", () => ({
  configNeedsSetup: vi.fn(),
  saveConfig: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  getOrphanedMeetings: vi.fn(),
  createNewMeeting: vi.fn(),
  updateMeetingStatus: vi.fn(),
  getDataDir: vi.fn(),
}));

vi.mock("@/lib/window", () => ({
  setClickThroughTracking: vi.fn().mockResolvedValue(undefined),
}));
```

Add a new `describe` block at the end of the file:

```tsx
describe("App click-through tracking", () => {
  it("activates click-through tracking when entering the Recording pill", async () => {
    const { setClickThroughTracking } = await import("@/lib/window");
    render(<App />);
    await screen.findByTestId("recorder");

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));

    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenCalledWith(true));
  });

  it("deactivates click-through tracking when returning to idle", async () => {
    const { setClickThroughTracking } = await import("@/lib/window");
    render(<App />);
    await screen.findByTestId("recorder");

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));
    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenCalledWith(true));

    fireEvent.click(await screen.findByRole("button", { name: "go-idle" }));
    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenLastCalledWith(false));
  });

  it("does not activate click-through tracking for the Idle state on initial render", async () => {
    const { setClickThroughTracking } = await import("@/lib/window");
    render(<App />);
    await screen.findByTestId("recorder");

    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenCalledWith(false));
    expect(setClickThroughTracking).not.toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/App.test.tsx --exclude '**/.claude/**'`
Expected: FAIL — `@/lib/window` doesn't exist yet, so the mock factory has
nothing real to shadow and `App.tsx` never calls it.

- [ ] **Step 3: Create the frontend wrapper**

Create `src/lib/window.ts`:

```ts
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
```

- [ ] **Step 4: Wire the effect into App.tsx**

In `src/App.tsx`, add the import alongside the existing ones:

```tsx
import { useAutoResizeWindow } from "@/hooks/useAutoResizeWindow";
```

becomes:

```tsx
import { useAutoResizeWindow } from "@/hooks/useAutoResizeWindow";
import { setClickThroughTracking } from "@/lib/window";
```

Add a new effect right after the existing pill-resize effect (after its
closing `}, [widgetState]);` and before the `configNeedsSetup` effect):

```tsx
  // Makes the pill's transparent corners (outside its rounded-full shape,
  // but still inside the actual rectangular OS window) click-through --
  // see src-tauri/src/commands/window_commands.rs for why this needs a
  // Rust-side poll loop rather than a JS mousemove listener. Idle is
  // deliberately excluded: its corner radius is small enough (rounded-lg)
  // that the same problem there is not worth the tracking overhead.
  useEffect(() => {
    void setClickThroughTracking(isPill).catch((err) =>
      console.error("Could not toggle click-through tracking:", err)
    );
  }, [isPill]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/App.test.tsx --exclude '**/.claude/**'`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run --exclude '**/.claude/**' --exclude '**/node_modules/**'`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

Ask the user for explicit go-ahead before running this.

```bash
git add src/lib/window.ts src/App.tsx src/App.test.tsx
git commit -m "feat: activate pill click-through tracking on Recording/Processing"
```

---

### Task 3: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Note the limitation**

No display or Tauri runtime is available in this implementing environment
(no `bun run tauri dev` possible here). This task must be done by the
user, not skipped or claimed as done without it. `set_ignore_cursor_events`
support on Linux (this project's primary platform) via the GTK backend
specifically needs live confirmation — this is flagged as a real risk, not
a formality, given this project's own history of WebKitGTK-specific quirks.

- [ ] **Step 2: Live check**

Run `bun run tauri dev`, start a recording, and confirm:
- Clicking on whatever is directly behind one of the pill's transparent
  corners (e.g. a window or desktop icon underneath) reaches that
  underlying content instead of being captured by the pill's window.
- Clicking anywhere on the visible pill itself (the Stop button, the
  waveform, the timer text) still works normally.
- Dragging the pill by its background still works normally.
- The same holds during the Processing pill, both in its normal spinner
  state and its Retry-button state (transcription failure), including when
  the qualityWarning icon is showing.
- Returning to Idle afterward: the full-chrome window is fully clickable
  everywhere (confirms the stop-tracking reset didn't leave anything stuck
  in an ignoring state).
- Move the cursor fast onto the Stop button from a transparent corner and
  click immediately, multiple times in a row; report whether any click is
  ever dropped (the 50ms poll interval and pill geometry thresholds could
  theoretically miss a very fast click near the pill's edge).
