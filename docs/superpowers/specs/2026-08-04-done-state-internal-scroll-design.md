# Done-State Internal Scroll — Design (fresh cycle, supersedes Task 2 of capped-window-height)

**Status:** approved, ready for implementation planning
**Date:** 2026-08-04

## Background

`docs/superpowers/specs/2026-08-04-capped-window-height-design.md` shipped a working
height cap (`useAutoResizeWindow` now stops the OS window from growing past 85% of the
current monitor's work area), but its Task 2 — making the Done state's already-present
`overflow-y-auto` Tabs content actually scroll once that cap is hit — shipped and does
**not** work. A whole-branch review reproduced the exact DOM chain and found the
`overflow-hidden` change added to `App.tsx`'s wrapper div had no effect, because the
premise was wrong: in the full-chrome (non-pill) state, `App.tsx`'s root container
(`rootRef`) has no height constraint at all. With nothing bounding it, the CSS flexbox
"shrink below content size" mechanism that `overflow-hidden` enables never has anything
to shrink *against* — there's no ceiling, so `min-height: auto` never needs to resolve to
anything smaller than the content's natural size in the first place.

The corresponding plan file (`docs/superpowers/plans/2026-08-04-capped-window-height.md`)
carries an explicit banner: don't re-attempt Task 2 as a one-line CSS patch; treat the
height-constraint propagation and the resize hook's own measurement strategy as one
combined problem. This document is that fresh cycle.

**User-reported symptom this fixes:** after a long meeting is summarized, the Done-state
window renders far taller than the screen, with no way to scroll down to reach the "Save
& Close" button — confirmed via screenshot, and via reading current source
(`src/App.tsx`, `src/hooks/useAutoResizeWindow.ts`, `src/components/RecorderWidget.tsx`)
rather than relying solely on the prior design doc.

## Why the obvious fix (give the root a real height) risks breaking measurement

`useAutoResizeWindow`'s `measure()` computes `total` by summing each direct child's
`scrollHeight`, deliberately reading the *natural, unclamped* content height so it knows
how tall the window *should* grow. If the root (or the tree under it) is given a height
tied to a viewport-relative unit (`h-screen`, `100vh`, or a percentage cascading from one)
*before* that same subtree is measured, the DOM's own layout becomes circular: window
size ← measured content height ← DOM layout ← the window's own current size. Once that
loop closes, content can never be observed as "wanting to grow," and the window gets
stuck. This is the most likely reason a "naive" height constraint was previously found to
break growth — not that bounding height is inherently wrong, but that tying the bound to
a viewport unit on the measured subtree collapses the very signal the algorithm reads.

## Design

**One change, in `useAutoResizeWindow.ts` only.** After `measure()` computes
`height = Math.min(cap, Math.max(minHeight, total))` (unchanged — `total` is still read
from natural, unconstrained `scrollHeight`, in that order, before any clamp is applied),
it additionally writes that same numeric value onto the observed root element as an
explicit inline pixel height:

```ts
el.style.height = `${height}px`;
```

This is a plain, JS-computed pixel value — never a viewport-relative unit — so there is
no circular dependency: `total` is always sampled from the DOM in its natural state
first, and the clamp is applied only as a downstream effect of a value already computed
from that reading. `scrollHeight` only reflects an element's true content extent when
read while that element is *unconstrained*. Once a height is imposed on `el` and the
flex/overflow chain beneath it (`h-full` → `flex-1 overflow-hidden` → `overflow-y-auto
flex-1`) redistributes that height and converts overflow into internal scroll, an
ancestor's own `scrollHeight` collapses to its allotted box instead of reporting the
content's true size — reading it back in that state on the *next* `measure()` call would
feed a shrunken number back in as `total`. This is why the implementation lifts the pin
(clears `el.style.height`) before every measurement and restores it synchronously
afterward, so `total` is always read from the DOM in its natural, unconstrained state.

**Cleanup matters.** `App.tsx`'s root `<div>` is a single JSX element whose `ref`/
`className` toggle via a ternary on `isPill` — React reconciles this as the *same* DOM
node across pill ⇄ full-chrome transitions, it is not remounted. Without an explicit
reset, an inline height left over from a capped Done state would persist onto that same
node and fight the pill's own `h-screen w-screen` sizing the next time `isPill` becomes
true. The effect's cleanup must clear it:

```ts
return () => {
  cancelled = true;
  observer.disconnect();
  el.style.height = "";
};
```

**No other file changes.** Confirmed against current source, not just the earlier design
doc:
- `App.tsx`'s wrapper around `<RecorderWidget>` (`flex-1 p-4 overflow-hidden`) is already
  in place from the previous (ineffective on its own) attempt — it becomes meaningful the
  moment its ancestor has a real height to shrink within.
- `RecorderWidget.tsx`'s Done-state root (`flex flex-col gap-2 h-full text-sm`) → `Tabs`
  (`flex-1 flex flex-col overflow-hidden`) → each `TabsContent`
  (`overflow-y-auto flex-1`) chain is already correct and needs no change.

Once the root has a genuine bounded height, this existing chain of `flex-1`/`h-full`/
`overflow` declarations resolves a real, definite height at every level, and the
innermost `TabsContent` panels' `overflow-y-auto` finally has something to activate
against — the Summary/Actions/Transcript tab a user is on becomes independently
scrollable, exactly as originally intended, while the Save/New Recording controls
outside the `Tabs` element stay pinned in view.

## Behavior for the common (non-capped) case

For any meeting whose content fits under the 85% cap — the overwhelming majority —
`height` already equals the natural content height today. Setting `el.style.height` to
that same value is a visual no-op: Idle, ConfigDialog, and short Done summaries render
pixel-identical to current behavior. The new code path only produces a different visual
result once `total` exceeds the cap, which is exactly the scenario this fix targets.

## Non-goals

- No change to the 85% cap fraction, the 700px fallback, or any other constant from the
  prior design.
- No change to `RecorderWidget.tsx`'s Tabs/TabsContent structure — confirmed already
  correct.
- No shadow/offscreen measurement node (considered and rejected — would require either
  duplicating `RecorderWidget`'s live state, which `App.tsx` explicitly guards against
  elsewhere via remount-prevention, or measuring a static snapshot that can drift from
  the real render; unnecessary complexity for what the JS-computed-height approach
  already solves).
- No change to when the window is allowed to grow vs. shrink — only whether the DOM
  inside it is ever told what its own real bound is.
- No support for within-session regrowth: once the Done state's window height is capped,
  switching tabs or regenerating a longer summary in the same session will not regrow the
  window, since each tab now scrolls independently within whatever height was set on
  Done-entry — an accepted, documented trade-off, not a regression to fix in this task.

## Testing

- `useAutoResizeWindow.test.tsx` (jsdom-based, existing suite): extend to assert
  `el.style.height` is set to the capped value once `total` exceeds the cap, and that it
  is cleared (`""`) when `enabled` transitions to `false`. jsdom cannot verify real
  flexbox layout or scrollbar rendering, but it can verify this plain style-property
  assignment and its cleanup, matching this repo's existing testing conventions for this
  hook.
- **Manual verification is the actual acceptance test for this fix**, per explicit
  decision made during design: after implementation, verify in the already-running
  `bun run tauri dev` with a meeting whose summary/transcript is long enough to exceed
  the cap — confirm the window stops growing at the same point as before, the current
  tab's content becomes scrollable (visible scrollbar, mouse-wheel/trackpad scroll
  works), and the Save & Close / New Recording controls are reachable without resizing
  the window. This is the step that was skipped or unverifiable for every prior round of
  this exact bug, and is why it shipped broken twice.
