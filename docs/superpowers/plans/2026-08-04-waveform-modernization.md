# Waveform Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Recording waveform's dated dot-fill rendering with rounded, eased-motion bars, while keeping its existing 3-tier volume color logic and every theme token exactly as configured (see `docs/superpowers/specs/2026-08-04-waveform-modernization-design.md`).

**Architecture:** Extract the two behavior-bearing pieces of `Waveform.tsx`'s draw loop — motion smoothing and color-by-intensity — into small named, exported pure functions that can be unit tested directly (jsdom has no real 2D canvas context, so the draw loop itself cannot be tested — see the design spec's Testing section). Then wire those functions into the draw loop, replacing `ctx.arc()` circle fills with rounded-line-cap bar strokes fed by the smoothed values instead of the raw analyser bytes.

**Tech Stack:** React 19, TypeScript, HTML5 Canvas 2D, Vitest + Testing Library.

## Global Constraints

- No changes to `index.css`, any theme/CSS custom property, or fonts.
- No changes to `Waveform`'s props (`{active, compact?}`) or its call site in `src/components/RecorderWidget.tsx:544`.
- No changes to bar density/spacing: `fftSize` (32 compact / 64 full), canvas `width`/`height` (90×20 compact / 320×60 full), and `minBarHeight` (1.5 compact / 2 full) all stay exactly as currently configured.
- The 3-tier color thresholds and their exact color values are unchanged: intensity `< 0.15` → `"hsl(220 9% 80%)"`, `< 0.5` → `"#F59E0B"`, else the live `--destructive` custom property.
- `SMOOTHING_FACTOR = 0.35` and bar `lineWidth = barWidth * 0.6` are starting values, not tunable by the implementer beyond what's specified in each task — if they look wrong once manually verified, that's a follow-up, not an in-task judgment call.

---

### Task 1: Extract and test the two pure helper functions

**Files:**
- Modify: `src/components/Waveform.tsx` (add two exported functions; component body unchanged in this task)
- Modify: `src/components/Waveform.test.tsx`

**Interfaces:**
- Produces: `export function easeTowards(current: number, target: number, factor: number): number` — moves `current` a `factor` fraction of the way toward `target`. Task 2 calls this once per bar, per frame.
- Produces: `export function colorForIntensity(intensity: number, destructiveColor: string): string` — maps a 0-1 intensity to one of the three theme colors. `destructiveColor` is passed in because it's read live from CSS at draw time, not hardcoded. Task 2 calls this once per bar, per frame.

- [ ] **Step 1: Write the failing tests**

Add to the top of `src/components/Waveform.test.tsx` (the existing `import` and first `describe` block stay as-is; add these alongside them):

```tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Waveform, easeTowards, colorForIntensity } from "./Waveform";

describe("Waveform", () => {
  it("renders a canvas element", () => {
    const { container } = render(<Waveform active={false} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });
});

describe("easeTowards", () => {
  it("moves partway from current toward target by the given factor", () => {
    expect(easeTowards(0, 100, 0.35)).toBeCloseTo(35);
  });

  it("returns current unchanged when already equal to target", () => {
    expect(easeTowards(50, 50, 0.35)).toBe(50);
  });

  it("moves the full distance when factor is 1", () => {
    expect(easeTowards(10, 90, 1)).toBe(90);
  });

  it("does not move when factor is 0", () => {
    expect(easeTowards(42, 90, 0)).toBe(42);
  });
});

describe("colorForIntensity", () => {
  const destructive = "oklch(0.577 0.245 27.325)";

  it("returns the quiet color below 0.15", () => {
    expect(colorForIntensity(0, destructive)).toBe("hsl(220 9% 80%)");
    expect(colorForIntensity(0.14, destructive)).toBe("hsl(220 9% 80%)");
  });

  it("returns the mid color from 0.15 up to (not including) 0.5", () => {
    expect(colorForIntensity(0.15, destructive)).toBe("#F59E0B");
    expect(colorForIntensity(0.49, destructive)).toBe("#F59E0B");
  });

  it("returns the passed-in destructive color at or above 0.5", () => {
    expect(colorForIntensity(0.5, destructive)).toBe(destructive);
    expect(colorForIntensity(1, destructive)).toBe(destructive);
  });
});
```

This file replaces the entirety of the current `src/components/Waveform.test.tsx` (the existing single test is preserved above, just with the import line extended).

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/components/Waveform.test.tsx`
Expected: the `Waveform` describe block's test still passes; every test in `easeTowards` and `colorForIntensity` fails with an error resolving to something like `"easeTowards is not a function"` / `"colorForIntensity is not a function"`, since neither is exported from `Waveform.tsx` yet.

- [ ] **Step 3: Add the two exported functions to Waveform.tsx**

Add these two functions to `src/components/Waveform.tsx`, above the `Waveform` component's own declaration (i.e., after the `WaveformProps` interface, before `export function Waveform(...)`):

```tsx
// Eases a displayed value a `factor` fraction of the way toward `target` —
// the standard exponential-smoothing technique audio visualizers use to
// avoid snapping instantly to each new raw sample.
export function easeTowards(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

// Maps a 0-1 volume intensity to one of the waveform's three theme colors.
// destructiveColor is a parameter (not hardcoded) because the draw loop
// reads it live from the --destructive CSS custom property, which can
// change with the theme.
export function colorForIntensity(intensity: number, destructiveColor: string): string {
  if (intensity < 0.15) return "hsl(220 9% 80%)";
  if (intensity < 0.5) return "#F59E0B";
  return destructiveColor;
}
```

Do not change anything else in the file in this task — the component's own draw loop still uses its old inline logic; Task 2 wires these functions in.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/Waveform.test.tsx`
Expected: all tests pass (1 in `Waveform`, 4 in `easeTowards`, 3 in `colorForIntensity`).

- [ ] **Step 5: Typecheck**

Run: `bun run build`
Expected: clean (tsc + vite build, no errors). The two new exports are unused by the component itself yet, which is not a TypeScript error (unused *exports* are fine; only unused *locals/parameters* would fail this repo's `noUnusedLocals`/`noUnusedParameters` strictness, and these are exported, not local).

- [ ] **Step 6: Commit**

```bash
git add src/components/Waveform.tsx src/components/Waveform.test.tsx
git commit -m "feat: extract testable easeTowards and colorForIntensity helpers from Waveform"
```

---

### Task 2: Wire rounded, eased-motion bars into the draw loop

**Files:**
- Modify: `src/components/Waveform.tsx`
- Modify: `src/components/Waveform.test.tsx`

**Interfaces:**
- Consumes: `easeTowards(current, target, factor)` and `colorForIntensity(intensity, destructiveColor)` from Task 1 (both already exported from this same file — call them directly, no import needed).

- [ ] **Step 1: Write the failing tests**

Add these two tests to the existing `describe("Waveform", ...)` block in `src/components/Waveform.test.tsx` (alongside the existing "renders a canvas element" test):

```tsx
  it("renders the full (non-compact) variant at its configured canvas size", () => {
    const { container } = render(<Waveform active={false} compact={false} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toHaveAttribute("width", "320");
    expect(canvas).toHaveAttribute("height", "60");
  });

  it("renders the compact variant at its configured canvas size", () => {
    const { container } = render(<Waveform active={false} compact />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toHaveAttribute("width", "90");
    expect(canvas).toHaveAttribute("height", "20");
  });
```

- [ ] **Step 2: Run the tests to verify current state**

Run: `npx vitest run src/components/Waveform.test.tsx`
Expected: these two new tests already PASS (the canvas `width`/`height` attributes are unaffected by this task's draw-loop changes — this step confirms the starting baseline, not a red-to-green cycle; the actual behavior change in this task, the drawing code, cannot be asserted on in jsdom, as explained in the design spec).

- [ ] **Step 3: Replace the draw loop's dot-fill rendering with bar strokes**

In `src/components/Waveform.tsx`, inside the `Waveform` component's `useEffect`, replace the whole `setup` function's body from `const dataArray = ...` through the end of the `draw` function definition with:

```tsx
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        // Per-bar smoothed intensity, eased toward the raw reading each
        // frame by easeTowards (see below) -- this is what makes the bars
        // glide instead of snapping to each new sample. Lives for the
        // lifetime of this effect run (same as dataArray above), not in a
        // ref: draw() closes over it directly.
        const displayed = new Float32Array(analyser.frequencyBinCount);
        const SMOOTHING_FACTOR = 0.35;

        // Check if effect was cancelled before starting draw loop.
        if (cancelled) {
          audioContext.close();
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }

        const draw = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          analyser.getByteFrequencyData(dataArray);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const barWidth = canvas.width / dataArray.length;
          // Read the live --destructive custom property fresh on every
          // frame (rather than once outside the loop) so a light/dark theme
          // toggle mid-recording is picked up immediately. This repo's
          // --destructive resolves to a plain CSS color value already
          // usable as-is -- unlike the old HSL-triplet convention, it must
          // NOT be wrapped in hsl(...), which would be an invalid color.
          //
          // The read can come back empty (the property not applied yet on the
          // first frames, or a stylesheet that has not landed). Assigning ""
          // to strokeStyle is silently ignored by the Canvas API, which would
          // leave the loudest bars painted in whatever strokeStyle was last set
          // -- black on the very first frame -- so fall back to the token's
          // own current light-theme value.
          const destructiveColor =
            getComputedStyle(document.documentElement).getPropertyValue("--destructive").trim() ||
            "oklch(0.577 0.245 27.325)";
          const centerY = canvas.height / 2;
          dataArray.forEach((value, i) => {
            const target = value / 255;
            displayed[i] = easeTowards(displayed[i], target, SMOOTHING_FACTOR);
            const barHeight = Math.max(minBarHeight, displayed[i] * canvas.height);
            const x = i * barWidth + barWidth / 2;
            ctx.beginPath();
            ctx.moveTo(x, centerY - barHeight / 2);
            ctx.lineTo(x, centerY + barHeight / 2);
            ctx.lineWidth = barWidth * 0.6;
            ctx.lineCap = "round";
            ctx.strokeStyle = colorForIntensity(displayed[i], destructiveColor);
            ctx.stroke();
          });
          rafRef.current = requestAnimationFrame(draw);
        };
        draw();
```

This replaces the old block that declared `dataArray` once (no `displayed` array), then had the cancellation check, then a `draw` function using `ctx.fillStyle`/`ctx.beginPath()`/`ctx.arc(x, y, barHeight / 2, 0, Math.PI * 2)`/`ctx.fill()` per bin. Everything outside this block (the `getUserMedia` call above it, the `catch`/cleanup below it, the component's props/return statement) is unchanged.

- [ ] **Step 4: Run the tests to verify they still pass**

Run: `npx vitest run src/components/Waveform.test.tsx`
Expected: all 10 tests pass across the file's three `describe` blocks (3 in `Waveform` — the original canvas-renders test plus this task's 2 new size tests, 4 in `easeTowards`, 3 in `colorForIntensity`, both from Task 1). The point is zero failures; if the actual count in the file differs from 10, trust the file over this number.

- [ ] **Step 5: Typecheck and full build**

Run: `bun run build`
Expected: clean.

- [ ] **Step 6: Run the full frontend test suite to confirm no regressions elsewhere**

Run: `npx vitest run --exclude "**/.claude/**"`
Expected: every test file passes, with 9 more passing tests total than before this plan started (7 added to `Waveform.test.tsx` in Task 1, 2 more added in this task's Step 1) — zero failures anywhere else in the suite.

- [ ] **Step 7: Manual verification**

Run: `bun run tauri dev`, start a recording, speak into the mic.
Expected: the Recording pill's waveform shows rounded bars (not circles) that glide smoothly between heights rather than snapping frame-to-frame, with the same three-tier color behavior as before (calm gray at low volume, amber at moderate volume, red at loud volume). If this cannot be run in the current environment (no display/Tauri runtime), say so explicitly in the task report rather than claiming it was checked — this is a known, standing limitation across this repo's UI work, not something to work around.

- [ ] **Step 8: Commit**

```bash
git add src/components/Waveform.tsx src/components/Waveform.test.tsx
git commit -m "feat: render the waveform as rounded, eased-motion bars instead of dots"
```
