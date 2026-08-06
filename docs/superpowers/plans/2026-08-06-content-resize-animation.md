# Smooth Content-Driven Resize Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every window resize the app drives from its own content (opening/closing the Settings panel, a Done-state summary growing the window, "New Recording" shrinking it back, etc.) animates smoothly instead of snapping instantly, using the same 180ms ease-out-cubic feel the Recording↔Processing pill transition already uses.

**Architecture:** Extract the pill transition's private `animateResize`/`easeOutCubic`/`currentWindowSize` helpers out of `src/App.tsx` into a new shared module, `src/lib/windowAnimation.ts`. `useAutoResizeWindow` (the hook that owns every content-driven resize, including the Settings panel) then calls the same `animateResize` instead of calling `setSize()` once directly, reusing its existing `cancelled`/`latestRun` staleness guards as the animation's cancellation check. The DOM height pin (`el.style.height`) keeps being written synchronously as it is today; a CSS transition on the root element makes that value change animate in lockstep with the JS-driven window resize.

**Tech Stack:** React 19 + TypeScript, Vite, Vitest + Testing Library (`@testing-library/react`), Tauri v2 (`@tauri-apps/api/window`, `@tauri-apps/api/dpi`), Tailwind CSS v4 (arbitrary-value utilities).

## Global Constraints

- Reuse the existing 180ms duration and ease-out-cubic easing exactly — do not introduce a different curve or timing for content-driven resizes (per the approved design spec, `docs/superpowers/specs/2026-08-06-content-resize-animation-design.md`).
- No change to *what* size the window resizes to, the per-monitor height cap, or the "lift the pin before reading `scrollHeight`" ratchet-avoidance logic — only *how* the transition between sizes looks.
- `prefers-reduced-motion` is explicitly out of scope (matches the existing, unaddressed pill animation).
- Run `bunx vitest run` and `bun run build` (tsc + vite build) before each commit that touches shared code, per this repo's convention of never committing on a red suite.

---

### Task 1: Extract animateResize/easeOutCubic/currentWindowSize into a shared, tested module

**Files:**
- Create: `src/lib/windowAnimation.ts`
- Create: `src/lib/windowAnimation.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces (from `src/lib/windowAnimation.ts`, consumed by Task 2):
  - `export function easeOutCubic(t: number): number`
  - `export async function animateResize(from: {width: number; height: number}, to: {width: number; height: number}, isCancelled?: () => boolean, durationMs?: number): Promise<void>`
  - `export async function currentWindowSize(): Promise<{width: number; height: number}>`

This task is a pure relocation — no behavior change. `App.tsx`'s Recording↔Processing pill transition must work exactly as it does today, just importing these three functions instead of defining them locally.

- [ ] **Step 1: Write the new module's tests (the module doesn't exist yet)**

Create `src/lib/windowAnimation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { easeOutCubic, animateResize, currentWindowSize } from "./windowAnimation";

const setSize = vi.fn(() => Promise.resolve());
const innerSize = vi.fn();
const scaleFactor = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setSize,
    innerSize: () => innerSize(),
    scaleFactor: () => scaleFactor(),
  }),
}));

// A controllable stand-in for requestAnimationFrame: queues callbacks instead
// of scheduling them on a real frame clock, so a test can advance the
// animation exactly one simulated frame at a time and assert on the
// intermediate state -- something waiting on jsdom's real ~16ms timer-backed
// rAF cannot do deterministically.
let rafCallbacks: FrameRequestCallback[] = [];
function flushRaf(time: number) {
  const callbacks = rafCallbacks;
  rafCallbacks = [];
  callbacks.forEach((cb) => cb(time));
}

beforeEach(() => {
  setSize.mockClear();
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("easeOutCubic", () => {
  it("returns 0 at t=0 and 1 at t=1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("front-loads the motion (past the halfway point by t=0.5)", () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 5);
  });
});

describe("animateResize", () => {
  it("interpolates from `from` to `to` using ease-out-cubic over durationMs", async () => {
    const promise = animateResize({ width: 0, height: 0 }, { width: 100, height: 200 }, undefined, 180);

    flushRaf(0);
    expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 0, height: 0 }));

    flushRaf(90); // halfway through the 180ms duration
    const midCall = setSize.mock.calls.at(-1)![0] as { width: number; height: number };
    expect(midCall.width).toBeCloseTo(87.5, 5);
    expect(midCall.height).toBeCloseTo(175, 5);

    flushRaf(200); // past the duration -- clamps to the final target
    await promise;
    expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 100, height: 200 }));
  });

  it("never calls setSize when already cancelled before the first frame", async () => {
    const promise = animateResize({ width: 0, height: 0 }, { width: 100, height: 100 }, () => true);
    flushRaf(0);
    await promise;
    expect(setSize).not.toHaveBeenCalled();
  });

  it("stops scheduling further frames once cancelled mid-animation", async () => {
    let cancelled = false;
    const promise = animateResize(
      { width: 0, height: 0 },
      { width: 100, height: 100 },
      () => cancelled,
      180
    );

    flushRaf(0);
    expect(setSize).toHaveBeenCalledTimes(1);

    cancelled = true;
    flushRaf(90); // the next queued frame must see isCancelled() and stop
    await promise;
    expect(setSize).toHaveBeenCalledTimes(1);
  });
});

describe("currentWindowSize", () => {
  it("converts the physical size to logical using the window's scale factor", async () => {
    scaleFactor.mockResolvedValue(2);
    innerSize.mockResolvedValue({
      toLogical: (factor: number) => ({ width: 800 / factor, height: 600 / factor }),
    });

    const size = await currentWindowSize();
    expect(size).toEqual({ width: 400, height: 300 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/lib/windowAnimation.test.ts`
Expected: FAIL — `Cannot find module './windowAnimation'` (the module doesn't exist yet).

- [ ] **Step 3: Create the shared module**

Create `src/lib/windowAnimation.ts`:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

// Tauri's setSize() has no built-in transition -- it snaps instantly. To make
// a resize feel intentional rather than jarring, step through intermediate
// sizes over a short duration with an ease-out curve. This is a manual
// animation of the actual OS window frame, not a CSS transition (CSS can't
// touch native window dimensions, only content drawn inside them). Shared by
// App.tsx's Recording <-> Processing pill transition and by
// useAutoResizeWindow's content-driven resizes.
//
// Caveat: stepping setSize() at animation-frame rate can look stepped/janky
// rather than smooth on some Linux window managers (particularly X11) --
// this could not be visually verified in this implementing environment (no
// display/Tauri runtime available here). If it looks janky in practice, the
// fallback is a single non-animated setSize() call straight to the target.
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// `isCancelled` is re-checked on every frame, before writing a size and before
// scheduling the next one, so an abandoned animation stops on its very next
// frame instead of running to completion. Without it two overlapping resize
// requests (e.g. a fast widgetState change, or new content arriving mid
// content-driven resize) would leave two animations writing conflicting sizes
// to the same window at animation-frame rate.
export async function animateResize(
  from: { width: number; height: number },
  to: { width: number; height: number },
  isCancelled: () => boolean = () => false,
  durationMs = 180
): Promise<void> {
  const win = getCurrentWindow();
  const start = performance.now();

  return new Promise<void>((resolve) => {
    function step(now: number) {
      if (isCancelled()) {
        resolve();
        return;
      }
      const elapsed = now - start;
      const t = Math.min(elapsed / durationMs, 1);
      const eased = easeOutCubic(t);
      const width = from.width + (to.width - from.width) * eased;
      const height = from.height + (to.height - from.height) * eased;
      win
        .setSize(new LogicalSize(width, height))
        .catch((err) => console.error("animateResize: setSize failed", err));
      if (t < 1 && !isCancelled()) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

// Reads the window's actual current logical size, so a resize animation can
// ease from wherever the window really is right now instead of assuming a
// stale previously-known size. Queried fresh every call (never cached), so
// there is nothing to go stale between callers.
export async function currentWindowSize(): Promise<{ width: number; height: number }> {
  const win = getCurrentWindow();
  const [physical, scaleFactor] = await Promise.all([win.innerSize(), win.scaleFactor()]);
  const logical = physical.toLogical(scaleFactor);
  return { width: logical.width, height: logical.height };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/windowAnimation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Update App.tsx to use the shared module**

In `src/App.tsx`:

1. Remove the `import { getCurrentWindow } from "@tauri-apps/api/window";` and `import { LogicalSize } from "@tauri-apps/api/dpi";` lines (both are now used only inside `windowAnimation.ts`).
2. Add `import { animateResize, currentWindowSize } from "@/lib/windowAnimation";` alongside the existing imports.
3. Delete the `easeOutCubic` function, its leading comment block ("Tauri's setSize() has no built-in transition..."), the `animateResize` function and its leading comment ("`isCancelled` is re-checked on every frame..."), and the `currentWindowSize` function and its leading comment ("Reads the window's actual current logical size...") — all now live in `src/lib/windowAnimation.ts`.
4. Leave the `PILL_SIZES` constant and everything inside the `App` function component (including the pill-transition `useEffect` that calls `currentWindowSize()` and `animateResize()`) completely unchanged — they now resolve to the imported functions instead of local ones, with identical behavior.

After this edit, `src/App.tsx` should have no remaining references to `getCurrentWindow`, `LogicalSize`, or local definitions of `easeOutCubic`/`animateResize`/`currentWindowSize`.

- [ ] **Step 6: Run the full frontend test suite and the production build**

Run: `bunx vitest run`
Expected: PASS (126 tests — 120 existing + 6 new from `windowAnimation.test.ts`).

Run: `bun run build`
Expected: PASS (tsc typecheck + vite build, no errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/windowAnimation.ts src/lib/windowAnimation.test.ts src/App.tsx
git commit -m "refactor: extract animateResize/easeOutCubic/currentWindowSize into a shared, tested module"
```

---

### Task 2: Animate useAutoResizeWindow's content-driven resizes

**Files:**
- Modify: `src/hooks/useAutoResizeWindow.ts`
- Modify: `src/hooks/useAutoResizeWindow.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `animateResize`, `currentWindowSize` from `src/lib/windowAnimation.ts` (Task 1).

- [ ] **Step 1: Update the hook test file's Tauri mock to support currentWindowSize()**

`useAutoResizeWindow.ts` is about to start calling `currentWindowSize()`, which needs `getCurrentWindow().innerSize()` and `.scaleFactor()` — the current mock in `src/hooks/useAutoResizeWindow.test.tsx` only provides `setSize`. Without this step, every test would have `currentWindowSize()` reject (logging a console error) and silently fall back to animating from-equals-to.

In `src/hooks/useAutoResizeWindow.test.tsx`, change:

```ts
const setSize = vi.fn((_size: { width: number; height: number }) => Promise.resolve());
const currentMonitor = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setSize }),
  currentMonitor: () => currentMonitor(),
}));
```

to:

```ts
const setSize = vi.fn((_size: { width: number; height: number }) => Promise.resolve());
const currentMonitor = vi.fn();
const innerSize = vi.fn();
const scaleFactor = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setSize,
    innerSize: () => innerSize(),
    scaleFactor: () => scaleFactor(),
  }),
  currentMonitor: () => currentMonitor(),
}));
```

And in the `beforeEach` block, change:

```ts
beforeEach(() => {
  setSize.mockClear();
  currentMonitor.mockReset().mockResolvedValue(null);
  FakeResizeObserver.instances = [];
```

to:

```ts
beforeEach(() => {
  setSize.mockClear();
  currentMonitor.mockReset().mockResolvedValue(null);
  // A fixed "current window size" baseline, distinct from every test's
  // computed target height, so animations in this file exercise real
  // interpolation instead of trivially starting already-at-target.
  innerSize.mockReset().mockResolvedValue({ toLogical: () => ({ width: 400, height: 300 }) });
  scaleFactor.mockReset().mockResolvedValue(1);
  FakeResizeObserver.instances = [];
```

- [ ] **Step 2: Update measure() to animate instead of snapping**

In `src/hooks/useAutoResizeWindow.ts`, change the imports:

```ts
import { useEffect, type RefObject } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
```

to:

```ts
import { useEffect, type RefObject } from "react";
import { currentMonitor } from "@tauri-apps/api/window";
import { animateResize, currentWindowSize } from "@/lib/windowAnimation";
```

Then, inside the effect, replace this block:

```ts
    let cancelled = false;
    let latestRun = 0;

    const measure = async () => {
      const run = ++latestRun;

      // Read scrollHeight with any previously-applied pin lifted first,
```

with:

```ts
    let cancelled = false;
    let latestRun = 0;

    const measure = async () => {
      const run = ++latestRun;
      // Shared by every staleness check below, and passed as animateResize's
      // cancellation check: if a newer measure() starts (a fresh
      // ResizeObserver fire, or this effect tearing down), an in-flight
      // resize animation from an older run stops on its next frame instead
      // of fighting the newer target.
      const isStale = () => cancelled || run !== latestRun;

      // Read scrollHeight with any previously-applied pin lifted first,
```

and replace this block:

```ts
      // This run was torn down or superseded while awaiting currentMonitor().
      // Do not write a stale size.
      if (cancelled || run !== latestRun) return;

      const heightCap = monitor
        ? monitor.workArea.size.toLogical(monitor.scaleFactor).height * HEIGHT_CAP_FRACTION
        : FALLBACK_HEIGHT_CAP;

      const height = Math.min(heightCap, Math.max(minHeight, total));
      getCurrentWindow()
        .setSize(new LogicalSize(width, height))
        .catch((err) => console.error("useAutoResizeWindow: setSize failed", err));

      // Gives the DOM an explicit, JS-computed bound equal to the same value
```

with:

```ts
      // This run was torn down or superseded while awaiting currentMonitor().
      // Do not write a stale size.
      if (isStale()) return;

      const heightCap = monitor
        ? monitor.workArea.size.toLogical(monitor.scaleFactor).height * HEIGHT_CAP_FRACTION
        : FALLBACK_HEIGHT_CAP;

      const height = Math.min(heightCap, Math.max(minHeight, total));

      // Eases from wherever the window actually is right now to the newly
      // computed target instead of snapping -- see windowAnimation.ts. A
      // failure here (e.g. no real Tauri runtime) falls back to animating
      // from the target to itself, which is a same-value no-op rather than
      // a crash.
      const from = await currentWindowSize().catch((err) => {
        console.error("useAutoResizeWindow: could not read current window size", err);
        return { width, height };
      });
      if (isStale()) return;

      animateResize(from, { width, height }, isStale).catch((err) =>
        console.error("useAutoResizeWindow: animateResize failed", err)
      );

      // Gives the DOM an explicit, JS-computed bound equal to the same value
```

Finally, update the comment just above `let cancelled = false;` (currently starting "measure() awaits a real Tauri IPC round-trip (currentMonitor())...") to:

```ts
    // measure() awaits real Tauri IPC round-trips (currentMonitor(),
    // currentWindowSize()), so it can still be suspended when this effect run
    // is torn down -- e.g. the widget leaves Idle/Done for the
    // Recording/Processing pill mid-measure. `cancelled` stops a torn-down
    // run from writing a stale size after the fact; `latestRun` stops an
    // older in-flight measure() from clobbering a newer one if the
    // ResizeObserver fires twice before the first resolves (out-of-order
    // resolution). Both are needed -- they guard different failure modes.
    // The same staleness check also cancels an in-flight resize *animation*:
    // if content changes again before the previous animation finishes, the
    // old animation stops on its next frame instead of fighting the new one.
```

Also update the comment directly above the final `el.style.height = \`${height}px\`;` line (currently ending "...instead of silently overflowing past the window's visible edge.") by appending one sentence: "Set synchronously here (not animated in JS) — App.tsx gives the root element a matching CSS transition so this value change animates in lockstep with the JS-driven window resize above."

- [ ] **Step 3: Run the existing test file and confirm the expected single failure**

Run: `bunx vitest run src/hooks/useAutoResizeWindow.test.tsx`
Expected: 13 tests PASS, 1 test FAILS — `does not ratchet the height down across repeated measurements` (it asserts `setSize` was called exactly once per `measure()` via `mock.calls[0]`/`mock.calls[1]` indexing; animating now produces multiple `setSize` calls per resize, so those indices no longer point at "the settled value for that measurement"). Every other test either checks `root.style.height` (set synchronously, unaffected by animation) or polls via `waitFor` for the eventual/last matching `setSize` call (still true once the animation completes).

- [ ] **Step 4: Fix the ratchet test to assert on the settled value instead of exact call count**

In `src/hooks/useAutoResizeWindow.test.tsx`, replace:

```ts
    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));

    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() => expect(setSize).toHaveBeenCalledTimes(1));
    const firstHeight = (setSize.mock.calls[0]![0] as { height: number }).height;

    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() => expect(setSize).toHaveBeenCalledTimes(2));
    const secondHeight = (setSize.mock.calls[1]![0] as { height: number }).height;

    expect(firstHeight).toBe(850);
    expect(secondHeight).toBe(firstHeight);
  });
```

with:

```ts
    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));

    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() =>
      expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 850 }))
    );

    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() =>
      expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 850 }))
    );
  });
```

(The surrounding `it(...)` description, the `currentMonitor`/`scrollHeight` setup above this block, and the explanatory comment above the test are unchanged.)

- [ ] **Step 5: Run the test file again to verify it fully passes**

Run: `bunx vitest run src/hooks/useAutoResizeWindow.test.tsx`
Expected: PASS (14 tests).

- [ ] **Step 6: Add a regression test for cross-measurement cancellation**

Append to `src/hooks/useAutoResizeWindow.test.tsx`, inside the `describe("useAutoResizeWindow", ...)` block:

```ts
  // Regression test for a failure mode that only exists once resizes
  // animate: two overlapping resize animations (one still easing toward a
  // now-stale target) must not fight each other. Exercises the same
  // isStale/latestRun guard already proven above for the async
  // currentMonitor() await, now also passed into animateResize as its
  // cancellation check.
  it("cancels an in-flight resize animation when new content is measured before it settles", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 500, configurable: true });

    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));

    FakeResizeObserver.instances[0]!.fire();
    // Let the first animation begin (easing from 300 toward 500) without
    // waiting for it to fully settle.
    await waitFor(() => expect(setSize).toHaveBeenCalled());

    // New, shorter content arrives mid-animation.
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 200, configurable: true });
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() =>
      expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 200 }))
    );

    // Give the cancelled first animation's remaining frames time to fire
    // (its full 180ms duration, generously padded) -- it must never
    // overwrite the second animation's settled value.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 200 }));
  });
```

- [ ] **Step 7: Run the test file to verify the new test passes**

Run: `bunx vitest run src/hooks/useAutoResizeWindow.test.tsx`
Expected: PASS (15 tests).

- [ ] **Step 8: Add a matching CSS transition to the root element**

In `src/App.tsx`, find the root `<div>`'s `className` ternary:

```tsx
      className={
        isPill
          ? "h-screen w-screen flex items-center justify-center bg-transparent"
          : // shadow-widget is the design-token elevation that lifts the
            // full-chrome container off the transparent OS window; the pill
            // carries its own smaller shadow-sm instead.
            "min-h-[300px] flex flex-col rounded-lg overflow-hidden border shadow-widget bg-background"
      }
```

Change the non-pill branch to add a CSS transition on `height`, matching `animateResize`'s 180ms ease-out-cubic timing so the DOM height pin (set synchronously by `useAutoResizeWindow`) visually animates in lockstep with the JS-driven window resize:

```tsx
      className={
        isPill
          ? "h-screen w-screen flex items-center justify-center bg-transparent"
          : // shadow-widget is the design-token elevation that lifts the
            // full-chrome container off the transparent OS window; the pill
            // carries its own smaller shadow-sm instead. The transition
            // matches animateResize's 180ms ease-out-cubic timing (see
            // windowAnimation.ts) so this element's JS-set explicit height
            // (useAutoResizeWindow.ts) animates in lockstep with the
            // window's own JS-driven resize instead of snapping ahead of it.
            "min-h-[300px] flex flex-col rounded-lg overflow-hidden border shadow-widget bg-background transition-[height] duration-[180ms] ease-[cubic-bezier(0.33,1,0.68,1)]"
      }
```

- [ ] **Step 9: Run the full frontend test suite and the production build**

Run: `bunx vitest run`
Expected: PASS (127 tests — 126 after Task 1, plus 1 new test added in this task's Step 6).

Run: `bun run build`
Expected: PASS (tsc typecheck + vite build, no errors).

- [ ] **Step 10: Manual verification note**

This implementing environment has no display or Tauri runtime, so the actual visual smoothness cannot be confirmed here. Once a display is available, run `bun run tauri dev` and verify: opening Settings (gear icon) grows the window smoothly rather than snapping; closing it (Save or Skip) shrinks it back smoothly; completing a recording (Done state, if the summary is tall) grows the window smoothly; "New Recording" from Done shrinks it back smoothly. Record the outcome before considering this plan fully verified.

- [ ] **Step 11: Commit**

```bash
git add src/hooks/useAutoResizeWindow.ts src/hooks/useAutoResizeWindow.test.tsx src/App.tsx
git commit -m "feat: animate content-driven window resizes (settings panel, done-state summary, etc.)"
```
