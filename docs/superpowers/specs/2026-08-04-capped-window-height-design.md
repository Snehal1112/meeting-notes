# Capped, Screen-Aware Window Height — Design

**Status:** approved, ready for implementation planning
**Date:** 2026-08-04

## Problem

`useAutoResizeWindow` (`src/hooks/useAutoResizeWindow.ts`) resizes the OS window to
exactly match its observed content's natural height, with no upper bound:
`height = Math.max(minHeight, total)`. For a long meeting summary, action-item list,
or transcript, this makes the window grow to match arbitrarily tall content — taller
than the physical screen in the reported case (screenshot: a wall of transcript text
filling the visible area with no way to see the rest).

This almost certainly also explains a second reported symptom: the window becoming
undraggable to a different connected monitor. Many window managers reposition or
re-center a window when its size changes significantly; a window taller than the
screen can end up with its title bar (the only drag handle) pushed above the visible
screen area, making it physically ungrabbable. Fixing the height cap is expected to
resolve both.

The Done state's Tabs content (`RecorderWidget.tsx`) already has `overflow-y-auto
flex-1` on each panel (Summary/Actions/Transcript), intended to let long content
scroll internally rather than growing the window — but it currently never gets the
chance to activate, because `useAutoResizeWindow` always keeps the window exactly as
tall as the content, so the panels are never actually shorter than what they contain.

## Goal

Cap the window's height so it can never exceed the current monitor's available work
area, and make the already-present internal scroll on the Done state's Tabs content
actually work once that cap is hit.

## Design

### 1. Screen-aware height cap in `useAutoResizeWindow`

`measure()` becomes async. On each call:

1. `const monitor = await currentMonitor();` (from `@tauri-apps/api/window`).
2. If `monitor` is non-null: `const workAreaLogical = monitor.workArea.size.toLogical(monitor.scaleFactor);` and cap at `workAreaLogical.height * 0.85`. `workArea` already excludes taskbars/docks, so no further adjustment is needed there.
3. If `monitor` is `null` (the API allows this, though it should be rare): fall back to a fixed cap of `700` logical pixels.
4. Final height: `Math.min(cap, Math.max(minHeight, total))` — the existing `minHeight` floor and content-driven `total` are unchanged; only a ceiling is added.

Re-querying `currentMonitor()` on every `measure()` call (rather than once) is
deliberate: `measure()` only runs when content actually changes (it's driven by the
existing `ResizeObserver`, not a timer), so the extra async call is infrequent, and
querying fresh means the cap is always correct for whichever monitor the window is
*currently* on, even if the user dragged it to a different one since the last
content change.

**New Tauri capability required.** `currentMonitor()` is a privileged API. Add
`core:window:allow-current-monitor` to `src-tauri/capabilities/default.json`'s
`permissions` array (verified directly against this project's own generated
`src-tauri/gen/schemas/desktop-schema.json` — this is the exact, correct identifier
for the installed Tauri version, not a guess).

### 2. Let the existing internal scroll actually activate

The one missing link: `App.tsx`'s `<div className="flex-1 p-4">` — the wrapper
between the resized root and `<RecorderWidget>` — has no `overflow` or `min-height`
handling, so per the CSS flexbox "automatic minimum size" rule, it resists shrinking
below its content's natural size even when its flex parent has less space to give it.
This is the same class of bug as the horizontal `min-w-0` truncation pattern already
used elsewhere in this codebase (e.g. `RecorderWidget.tsx`'s Processing pill), just
the vertical analog: a flex item's default `min-height: auto` only resolves to `0`
(letting it actually shrink) when the item's own `overflow` is not `visible`.

Fix: add `overflow-hidden` to that one wrapper div's className. Once the cap in
part 1 makes the root window genuinely shorter than the content wants, this lets
that constraint cascade down through `RecorderWidget`'s own `flex flex-col gap-2
h-full` Done-state root (already `h-full`, needs no change) into the `Tabs`
element (already `flex-1 overflow-hidden`, needs no change) into each `TabsContent`
panel (already `overflow-y-auto flex-1`, needs no change) — every other link in the
chain was already correct; this one wrapper was the sole gap.

## Non-goals

- No manual resize handle or user-configurable cap.
- Idle and ConfigDialog inherit the same cap via the shared hook, but are not
  otherwise touched — their content is always well under 85% of any real monitor's
  work area, so this is a no-op for them in practice.
- No change to `RecorderWidget.tsx`'s Tabs/TabsContent structure — already correct.
- Not attempting to independently diagnose or fix the drag-to-another-monitor issue
  as a separate bug; the hypothesis that it's a consequence of unbounded height is
  strong (a window taller than a screen having its title bar pushed off-screen is a
  well-understood failure mode) but unverified in a live environment — see Testing.

## Testing

`useAutoResizeWindow`'s existing test file already mocks `getCurrentWindow()` and
`ResizeObserver` (per the earlier fix wave in this session that added the `enabled`
parameter) — extend those mocks to also stub `currentMonitor()` and assert the cap
math: a monitor with a given `workArea`/`scaleFactor` produces the expected capped
`setSize()` call when content exceeds 85% of its logical work-area height, and that
content shorter than the cap is unaffected (existing behavior preserved). Also test
the `null`-monitor fallback path.

**Known verification gap (carried over from every prior UI task in this repo):**
there is no display or Tauri runtime in the implementing environment, so whether the
window genuinely stays on-screen and the Tabs content genuinely becomes scrollable —
and whether this actually fixes the multi-monitor drag issue — cannot be confirmed
here, only reasoned through from the code and unit-tested in isolation. A live
`bun run tauri dev` pass with a long transcript, on a real screen, is the only way to
confirm this, and is still owed across everything built in this repo's UI work so
far.
