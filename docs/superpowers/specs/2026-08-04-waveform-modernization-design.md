# Waveform Modernization — Design

**Status:** approved, ready for implementation planning
**Date:** 2026-08-04

## Problem

The Recording state's waveform (`src/components/Waveform.tsx`) draws the live mic
input as discrete filled circles, one per FFT frequency bin, each frame drawn
directly from the raw analyser byte value. This reads as dated and jerky: circles
snap instantly to the new value every animation frame with no easing, and the
dot shape doesn't match the rounded, bar-based look of most modern audio/voice
UIs.

The theme system (colors, fonts) was deliberately reverted to the user's original
shadcn configuration in the previous session and must not be touched again here —
this is a rendering-technique change only, not a palette change.

## Goal

Modernize the waveform's shape and motion — rounded bars instead of dots, eased
motion instead of raw per-frame snapping — while keeping its existing 3-tier
volume-based coloring (quiet/mid/loud) and every existing theme token exactly as
configured. Confirmed via a visual mockup comparison (Option B of four shown).

## Scope

`src/components/Waveform.tsx` only. No prop/API change — `{active, compact}`
stays identical, so `RecorderWidget.tsx` (the sole real call site) needs no
changes. No new theme tokens, no `index.css` changes, no dependency changes.

## Design

**Shape — bars instead of dots.** Replace the per-bin `ctx.arc()` circle fill
with a vertical line stroke per bar:

```ts
ctx.beginPath();
ctx.moveTo(x, centerY - barHeight / 2);
ctx.lineTo(x, centerY + barHeight / 2);
ctx.lineWidth = barWidth * 0.6; // leaves a visible gap between bars; adjustable by feel
ctx.lineCap = "round";
ctx.strokeStyle = color;
ctx.stroke();
```

Round line-caps give pill-shaped bar ends with no cross-browser compatibility
concern (unlike `CanvasRenderingContext2D.roundRect`, which needs a fallback on
older WebKitGTK — this project's primary runtime is Tauri's system WebKitGTK on
Linux). At the existing minimum bar height, a rounded-cap zero-length line
degenerates into a small filled circle — a calm idle-state dot falls out of this
change for free, with no extra branching.

**Motion — eased instead of raw.** Currently each `draw()` call reads
`analyser.getByteFrequencyData()` and paints that value directly, which is the
source of the jerkiness. Introduce a persistent `Float32Array` (sized to
`dataArray.length`, held in a `useRef`, initialized once per `active` mount)
holding each bar's currently-displayed intensity. Each frame, before drawing,
ease every entry toward its fresh target:

```ts
const SMOOTHING_FACTOR = 0.35; // starting point; adjustable by feel once seen running
displayed[i] += (target[i] - displayed[i]) * SMOOTHING_FACTOR;
```

This is the standard exponential-smoothing technique used by audio visualizers —
no new dependency, a few lines inside the existing `draw()` closure. Bar height
and color are then computed from `displayed[i]`, not the raw byte value.

**Color — unchanged.** The existing three thresholds and their exact colors stay
as-is: quiet `hsl(220 9% 80%)`, mid `#F59E0B`, loud the live `--destructive`
custom property (already read fresh per frame via `getComputedStyle`, with the
existing empty-string fallback guard). The only change is that the threshold
comparison runs against the smoothed value instead of the raw one, so color
transitions ease along with height instead of flickering between tiers.

**Bar density/spacing.** Unchanged — `fftSize` (and therefore bar count) and the
`width`/`height`/`minBarHeight` constants for both the `compact` and full
variants stay exactly as currently configured. Not part of what was asked for;
changing it would widen the diff for a cosmetic call that wasn't part of this
request.

## Non-goals

- Any change to `index.css`, theme tokens, or fonts.
- Any change to `Waveform`'s props or its call site in `RecorderWidget.tsx`.
- Re-tuning bar count/spacing/canvas dimensions.
- A live/interactive visual polish pass beyond what's specified above — if the
  eased motion or bar proportions need further tuning once seen running, that's
  a follow-up, not blocking this work.

## Testing

The existing test (`Waveform.test.tsx`) asserts only that a `<canvas>` element
renders — jsdom has no real 2D canvas context, so `getContext("2d")` returns
`null` in tests today and the draw loop's existing `if (!ctx) return;` guard
already bails before any drawing code runs. This means the shape/motion/color
changes above are not exercised by the existing test either before or after —
add one more smoke-level test (e.g. `compact` vs. full both render without
throwing) at the same level, but do not attempt to assert on canvas pixel
output.

**Known verification gap (carried over from prior sessions in this repo):**
there is no display or Tauri runtime in the implementing environment, so the
actual smoothness/visual feel cannot be confirmed here — only reasoned through
from the drawing code. A live `bun run tauri dev` pass is the only way to
confirm this reads as intended, and is still owed across everything built in
this repo's UI redesign work so far.
