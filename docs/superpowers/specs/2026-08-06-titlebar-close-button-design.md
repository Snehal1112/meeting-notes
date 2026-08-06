# TitleBar Close Button Design

**Goal:** There is currently no way for the user to close the meeting-notes
app from the UI. `tauri.conf.json` sets `decorations: false` (no native OS
title bar, no OS close button), and no in-app close control, tray icon,
quit menu, or keyboard shortcut exists anywhere in the codebase. This adds
a close button to the custom `TitleBar` component that quits the app.

**Explicitly out of scope:** The Recording and Processing pill states are
untouched — the close control only needs to exist in the Idle state, where
`TitleBar` already renders. No confirmation/warning dialog on close: since
the control is Idle-only, there is never an in-progress recording to lose
when it's reachable. No tray icon, no keyboard shortcut, no "hide instead
of quit" behavior.

---

## Architecture / Components

**`src/components/TitleBar.tsx`** gets a close button that calls
`getCurrentWindow().close()` from `@tauri-apps/api/window` (already used
elsewhere in the codebase, e.g. `App.tsx`'s resize logic). This is a
single-window app with no `on_window_event` / `ExitRequested` override in
`src-tauri/src/lib.rs`, so Tauri's default behavior applies: closing the
only window exits the whole process. No new dependency, no Rust changes to
window-close behavior itself.

The button sits inside `TitleBar`'s existing drag region
(`data-tauri-drag-region` + `startWindowDrag` fallback for WebKitGTK — see
`src/lib/drag.ts`). Today `TitleBar`'s `onMouseDown` handler omits
`requireSelfTarget` because its only children (3 grip dots) are decorative;
adding a real interactive button means a press on it must not be swallowed
into a window drag, so the handler needs `requireSelfTarget: true` — the
same pattern `RecorderWidget.tsx`'s Stop and Retry buttons already use for
buttons living inside a drag surface.

## Permissions

`core:default`'s nested `core:window:default` permission set does **not**
include `allow-close` (verified directly against
`src-tauri/gen/schemas/desktop-schema.json`, the same way the `openPath`
permission gap was found and fixed earlier). `src-tauri/capabilities/default.json`
needs `"core:window:allow-close"` added to its `permissions` array, or the
close call is silently rejected by Tauri's IPC layer exactly like the
`summary.md` auto-open bug was. Unlike the opener plugin's `open_path`,
window commands aren't scoped by path — this is a plain string permission
entry, no scope object needed.

## Layout

`TitleBar` is currently:

```tsx
<div
  data-tauri-drag-region
  onMouseDown={(e) => startWindowDrag(e)}
  className="h-8 flex items-center justify-center gap-1 select-none bg-muted/50"
>
  {[0, 1, 2].map((i) => (
    <span key={i} className="h-1 w-1 rounded-full bg-muted-foreground/40" />
  ))}
</div>
```

Switches to `justify-between`: the three grip dots move into their own
centered `flex-1` wrapper (keeping them visually centered as before), and
the close button anchors to the right in its own slot. Icon: lucide's `X`,
using the existing icon-button convention seen elsewhere in the codebase
(`Button variant="ghost" size="icon"`, matching the subtle, non-alarming
styling appropriate for a title bar control — the Stop button's `destructive`
styling is reserved for stopping an active recording, not for this).

## Data Flow / Error Handling

No new component state. `getCurrentWindow().close()` returns a promise;
failures (no window, IPC rejection) are `console.error`'d — the same
pattern `startWindowDrag` already uses for its own Tauri call failures, and
consistent with how the rest of the codebase handles Tauri calls with no
meaningful in-app recovery path.

## Testing

New `src/components/TitleBar.test.tsx` (no test file exists for this
component today):
- Renders the close button and asserts it's present.
- Clicks it and asserts the mocked `getCurrentWindow().close` was called.
- Clicking a grip dot (or any point in the drag region other than the
  button) does not call `close`.

Only the Idle state renders `TitleBar`, so there is no Recording/Processing
interaction to test.
