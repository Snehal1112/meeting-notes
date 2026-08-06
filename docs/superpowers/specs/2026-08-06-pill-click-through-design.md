# Pill Click-Through Design

**Goal:** The Recording and Processing pills render as a `rounded-full`
(stadium-shaped) `h-full w-full` div that exactly fills the actual OS
window rectangle. `tauri.conf.json` sets `transparent: true`, which only
affects rendering — it does not make the window click-through anywhere.
The four corners of the rectangle, outside the pill's curved boundary, are
visually transparent but still fully part of the window's clickable hit
area, so clicks that land there are captured by this app's window instead
of passing through to whatever is behind it. This adds dynamic click-through
for those corner regions: the window ignores cursor events whenever the
cursor is over a transparent corner, and processes them normally whenever
it's over the visible pill.

**Explicitly out of scope:** The Idle state (`rounded-lg`, ~8px corner
radius) is untouched — its corner gap is comparatively tiny and not part of
this change. No change to the pill's visual appearance, sizing, or any
other window behavior.

---

## The Core Problem

`Window::set_ignore_cursor_events(bool)` is Tauri's mechanism for this, but
it's a blunt, whole-window toggle. Once a window is ignoring cursor events,
it also stops receiving webview-level mouse events (e.g. `mousemove`) — so
a naive JS-side implementation (track `mousemove`, toggle ignore based on
position) cannot detect when the cursor re-enters the visible pill, because
once ignoring starts, the webview never sees the re-entry event. The
correct approach polls the OS-level global cursor position from Rust
(`Window::cursor_position()`), which is independent of this window's own
hit-testing state and keeps working regardless of the ignore flag.

## Architecture

**`src-tauri/src/commands/window_commands.rs`** (new file, following the
existing `commands/*.rs` per-feature-area convention):

- Managed state (`.manage(...)`, matching the existing `RecordingState`
  pattern) holding the currently-running poll task's handle, so it can be
  stopped.
- `set_click_through_tracking(active: bool)` command: starts a
  `tauri::async_runtime::spawn` loop when `active` transitions to `true`
  (aborting any existing one first, defensively); aborts the running loop
  and explicitly calls `set_ignore_cursor_events(false)` when `active`
  transitions to `false`. The explicit reset-on-stop is required — without
  it, stopping mid-loop while the cursor happens to be over a corner would
  leave the window permanently non-interactive until manually toggled
  again, since aborting the task alone doesn't touch the ignore flag.
- The loop body, each tick (50ms interval):
  1. Read the window's current `inner_position()` and `inner_size()`.
  2. Read the global cursor position via `cursor_position()`.
  3. Convert to window-relative coordinates.
  4. Run `is_inside_pill(relative_cursor, window_size) -> bool` — a pure,
     unit-testable function computing whether the point lies inside a
     stadium shape of the given size (radius = height / 2, matching the
     `rounded-full` CSS exactly, self-describing from the window's own live
     size so there's no duplicated/hardcoded radius value to keep in sync
     with the frontend).
  5. Call `set_ignore_cursor_events` only when the computed state differs
     from the last-applied one, to avoid redundant calls every tick.

**`src/lib/window.ts`** (new file, matching the existing `lib/*.ts` per-area
convention): exports `setClickThroughTracking(active: boolean): Promise<void>`,
wrapping the new `invoke`.

**`src/App.tsx`**: one new effect keyed on the existing `isPill` boolean
(already the established boundary between "chrome-less pill" and "full
window" elsewhere in this file):

```tsx
useEffect(() => {
  void setClickThroughTracking(isPill).catch((err) =>
    console.error("Could not toggle click-through tracking:", err)
  );
}, [isPill]);
```

This only ever activates during Recording/Processing.

## Permission

`core:window:allow-set-ignore-cursor-events` must be added to
`src-tauri/capabilities/default.json` (verified directly against
`gen/schemas/desktop-schema.json`) — a plain string entry, no scope object
needed (unlike the opener plugin's path-scoped permissions), since window
commands aren't scoped by path.

## Platform Risk

`set_ignore_cursor_events` on Linux ultimately depends on GTK's window
pass-through support via the `tao`/`wry` stack underneath Tauri. This
cannot be verified live in the implementing environment (no display) —
flagged as a required manual-verification follow-up, consistent with every
other window-behavior change made this session.

## Testing

- **Rust:** unit tests for `is_inside_pill` covering the straight middle
  section, both rounded end-caps, and points just outside each region
  (corner dead zones) — using the project's existing `#[cfg(test)] mod
  tests` convention (see `summary_commands.rs`, `transcription_commands.rs`
  for precedent).
- **Frontend:** extend `App.test.tsx`'s existing Tauri mocks to cover the
  new `set_click_through_tracking` invoke, asserting it's called with
  `true` on transitions into Recording/Processing and `false` on
  transitions back to Idle.
- No live/manual verification is possible in this environment — flagged as
  an outstanding follow-up for the user.
