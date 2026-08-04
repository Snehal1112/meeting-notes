# Capped Window Height Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **PARTIAL COMPLETION — read before touching this area again.** Task 1 (the
> height cap itself) shipped and works, including a follow-up fix for an
> async cancellation race the final whole-branch review caught (commit
> `badc0bc`, not written as a separate task below since it wasn't part of
> the original plan). **Task 2, as designed and written below, does NOT
> work — confirmed empirically, not just reasoned about.** The final
> reviewer reproduced the exact DOM chain in headless Chrome and got
> byte-identical layout measurements with and without Task 2's
> `overflow-hidden` change. Root cause the design spec got wrong: in the
> full-chrome (non-pill) state, `App.tsx`'s root container has **no height
> constraint at all** (no `h-screen`, no max-height) — there is no bounded
> space for anything downstream to ever shrink against, so
> `overflow-hidden` on the wrapper has nothing to do. Worse: naively adding
> a height constraint to the root breaks `useAutoResizeWindow`'s own
> measurement in a new way — once the wrapper's `scrollHeight` reflects its
> own clamped height instead of the true content height, the window could
> never grow past its current size again. **Net effect of what's actually
> shipped:** the window now correctly stops growing past the cap, but
> content between the cap and the true content height is silently
> unreachable — no scrollbar, since the global `overflow: hidden` safety
> net (`src/index.css`) suppresses even a document-level scrollbar. This
> was a conscious, user-approved trade-off (ship the cap now, fix scrolling
> separately) — not a bug shipped by accident. **Task 2 needs a fresh
> brainstorming → design → plan cycle that treats the height-constraint
> propagation and the resize-hook's measurement strategy as one combined
> problem, not a one-line CSS patch.** Do not re-attempt Task 2 as written
> below.

**Goal:** Cap the window's auto-resize height so it can never exceed 85% of the current monitor's available work area (falling back to a fixed 700px if the monitor can't be queried), and fix the one wrapper div that currently prevents the Done state's already-present internal scroll from activating once that cap is hit. See `docs/superpowers/specs/2026-08-04-capped-window-height-design.md` for the full design rationale.

**Architecture:** `useAutoResizeWindow`'s `measure()` becomes async, querying Tauri's `currentMonitor()` API on every call and capping the computed height against its logical work-area height. A new Tauri capability permission (`core:window:allow-current-monitor`, verified against this project's own generated schema) is required for that API call to succeed at runtime. Separately, `App.tsx`'s wrapper div between the resized root and `RecorderWidget` gains `overflow-hidden` so the CSS flexbox "automatic minimum size" rule stops preventing it from shrinking below its content's natural height — this is what lets the cap actually cascade down into the already-correct `overflow-y-auto` Tabs panels instead of the content just silently overflowing.

**Tech Stack:** React 19, TypeScript, Tauri v2 (`@tauri-apps/api/window`), Vitest + Testing Library.

## Global Constraints

- Height cap fraction is `0.85` (85%) of the current monitor's logical work-area height — not tunable per-task.
- Fallback cap when `currentMonitor()` resolves to `null` is `700` logical pixels.
- The existing `minHeight` floor and content-driven `total` calculation in `useAutoResizeWindow` are unchanged — only a ceiling is added on top.
- The new Tauri permission identifier is exactly `core:window:allow-current-monitor` — this was verified directly against `src-tauri/gen/schemas/desktop-schema.json` in this repo, not guessed; do not substitute a different-looking identifier.
- No changes to `RecorderWidget.tsx`'s Tabs/TabsContent structure — already correct per the design spec's analysis.

---

### Task 1: Add the screen-aware height cap to useAutoResizeWindow — DONE (commit `b810bf2`), plus a final-review fix for an async cancellation race (commit `badc0bc`)

> **Deviation:** the final whole-branch review found that `measure()` becoming
> `async` (to await `currentMonitor()`) opened a stale-write race —
> `observer.disconnect()` only stops *future* callbacks, not one already
> suspended at the `await` — reopening a bug class already fixed once
> elsewhere in this repo (`App.tsx`'s `resizeRunRef`, `RecorderWidget.tsx`'s
> `summarizeRunRef`). Fixed with the same pattern: a `cancelled` flag (set in
> the effect cleanup) plus a `latestRun` counter (so an earlier-started,
> later-resolving call can't overwrite a newer one even without a teardown).
> A regression test proves a call that resolves after the hook is disabled
> never calls `setSize()`. Re-reviewed clean.

**Files:**
- Modify: `src/hooks/useAutoResizeWindow.ts`
- Modify: `src/hooks/useAutoResizeWindow.test.tsx`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- `useAutoResizeWindow`'s exported signature (`(ref, width, minHeight, enabled?)`) is unchanged — this task only changes its internal height calculation, not its public API. No other file calls this hook differently as a result of this task.

- [x] **Step 1: Add the new Tauri capability permission**

In `src-tauri/capabilities/default.json`, add `"core:window:allow-current-monitor"` to the `permissions` array. The file currently reads:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "core:window:allow-start-dragging",
    "core:window:allow-set-size"
  ]
}
```

Change the `permissions` array to:

```json
  "permissions": [
    "core:default",
    "opener:default",
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-current-monitor"
  ]
```

- [x] **Step 2: Write the failing tests**

Replace the entirety of `src/hooks/useAutoResizeWindow.test.tsx` with the following (this extends the existing `vi.mock` to include a mockable `currentMonitor`, updates the one existing test that becomes async as a result, and adds three new tests for the cap behavior — every other existing test is otherwise unchanged):

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAutoResizeWindow } from "./useAutoResizeWindow";

const setSize = vi.fn(() => Promise.resolve());
const currentMonitor = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setSize }),
  currentMonitor: () => currentMonitor(),
}));

// jsdom has no ResizeObserver. This stand-in also records every instance, so
// a test can assert that toggling `enabled` really tears the observer down
// and builds a fresh one -- which is the whole point of the parameter.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let root: HTMLDivElement;
const ref = { current: null as HTMLElement | null };

beforeEach(() => {
  setSize.mockClear();
  // Default: no monitor info (exercises the fallback path unless a test
  // overrides this with mockResolvedValueOnce for a specific monitor shape).
  currentMonitor.mockReset().mockResolvedValue(null);
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  root = document.createElement("div");
  root.appendChild(document.createElement("div"));
  document.body.appendChild(root);
  ref.current = root;
});

afterEach(() => {
  root.remove();
  vi.unstubAllGlobals();
});

// A monitor whose workArea is 1000 logical px tall at scaleFactor 1 (chosen
// so the math is easy to verify by hand): the physical workArea.size.height
// equals the logical height directly, and toLogical(1) is a no-op division.
function fakeMonitor(workAreaHeightLogical: number) {
  return {
    name: "Fake Monitor",
    size: { width: 0, height: 0 },
    position: { x: 0, y: 0 },
    workArea: {
      position: { x: 0, y: 0 },
      size: {
        width: 0,
        height: workAreaHeightLogical,
        toLogical: (scaleFactor: number) => ({
          width: 0,
          height: workAreaHeightLogical / scaleFactor,
        }),
      },
    },
    scaleFactor: 1,
  };
}

describe("useAutoResizeWindow", () => {
  it("measures and resizes the window while enabled", async () => {
    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));

    expect(FakeResizeObserver.instances).toHaveLength(1);
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() =>
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 400, height: 300 }))
    );
  });

  // Regression test for the bug that stopped the window ever reaching the
  // Recording/Processing pill size: App.tsx switched off content-driven
  // sizing by detaching the ref, but an observer created on the first render
  // keeps observing the elements it was handed no matter what ref.current
  // becomes later. Every step of the pill's resize animation changed the
  // observed content box, re-fired this hook's measure(), and pulled the
  // window straight back to 400x300.
  it("creates no observer at all while disabled", () => {
    renderHook(() => useAutoResizeWindow(ref, 400, 300, false));

    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(setSize).not.toHaveBeenCalled();
  });

  it("disconnects the live observer when it becomes disabled", () => {
    const { rerender } = renderHook(({ enabled }) => useAutoResizeWindow(ref, 400, 300, enabled), {
      initialProps: { enabled: true },
    });
    const first = FakeResizeObserver.instances[0]!;
    expect(first.disconnected).toBe(false);

    rerender({ enabled: false });

    expect(first.disconnected).toBe(true);
    expect(FakeResizeObserver.instances).toHaveLength(1);
  });

  // Leaving the pill hands sizing back to this hook, so it has to start
  // observing again rather than staying permanently off.
  it("builds a fresh observer when it is re-enabled", () => {
    const { rerender } = renderHook(({ enabled }) => useAutoResizeWindow(ref, 400, 300, enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    rerender({ enabled: true });

    expect(FakeResizeObserver.instances).toHaveLength(2);
    const latest = FakeResizeObserver.instances[1]!;
    expect(latest.disconnected).toBe(false);
    expect(latest.observed).toContain(root);
  });

  it("defaults to enabled when the parameter is omitted", () => {
    renderHook(() => useAutoResizeWindow(ref, 400, 300));
    expect(FakeResizeObserver.instances).toHaveLength(1);
  });

  it("caps the height at 85% of the current monitor's logical work-area height", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    // Content taller than the cap: make the single child's scrollHeight
    // exceed 850 (1000 * 0.85) so the cap -- not the content height -- wins.
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 5000, configurable: true });

    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() =>
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 400, height: 850 }))
    );
  });

  it("falls back to a fixed 700px cap when currentMonitor() resolves to null", async () => {
    currentMonitor.mockResolvedValue(null);
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 5000, configurable: true });

    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() =>
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 400, height: 700 }))
    );
  });

  it("is unaffected by the cap when content is shorter than it", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 500, configurable: true });

    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() =>
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 400, height: 500 }))
    );
  });
});
```

- [x] **Step 3: Run the tests to verify the new/changed ones fail**

Run: `npx vitest run src/hooks/useAutoResizeWindow.test.tsx --exclude "**/.claude/**"`
Expected: the async-ified "measures and resizes the window while enabled" test and the three new cap tests fail (the hook doesn't call `currentMonitor()` yet, so the mock is never exercised and the height calculation doesn't cap); the other four pre-existing tests (disabled/disconnects/rebuilds/defaults-enabled) still pass, since they don't depend on the new behavior.

- [x] **Step 4: Add the height cap to useAutoResizeWindow.ts**

Replace the entirety of `src/hooks/useAutoResizeWindow.ts` with:

```ts
import { useEffect, type RefObject } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

// Resizes the OS window to match the content's natural height, so panels
// taller than the widget's default 300px (e.g. the config panel) grow the
// window instead of scrolling internally -- up to a per-monitor cap. Beyond
// that cap the window stops growing and the internal overflow-y-auto panels
// in RecorderWidget.tsx's Done-state Tabs content take over instead. Without
// a cap, a long meeting summary/transcript could grow the window taller
// than the screen, which both hides content with no way to reach it and can
// push the title bar (the only drag handle) off-screen, making the window
// undraggable to another monitor.
const HEIGHT_CAP_FRACTION = 0.85;
const FALLBACK_HEIGHT_CAP = 700; // logical px, used when currentMonitor() returns null

// `enabled` is a real dependency of the effect, not a convenience flag: the
// caller needs to be able to switch this measurement off entirely while
// something else owns the window size (App.tsx's Recording/Processing pill).
// Detaching the ref is not enough to do that. Once the ResizeObserver below
// exists it keeps observing the elements it was handed, whatever `ref.current`
// later becomes, so every step of the pill's resize animation would change the
// observed content box, re-fire measure(), and set the window straight back to
// `width` x content height. Turning `enabled` off tears the observer down;
// turning it back on re-creates it, and ResizeObserver.observe() fires an
// initial callback that re-measures the content immediately.
export function useAutoResizeWindow(
  ref: RefObject<HTMLElement | null>,
  width: number,
  minHeight: number,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    const measure = async () => {
      // el's own scrollHeight is unreliable here: it's a flex-col container
      // with overflow-hidden, and its children (e.g. a scrollable panel) can
      // themselves be clipped to whatever height the window currently is,
      // understating how much content actually needs. Sum each direct
      // child's natural scrollHeight instead -- that's the real total.
      const total = Array.from(el.children).reduce(
        (sum, child) => sum + child.scrollHeight,
        0
      );

      // Queried fresh on every measure() call (not cached across renders) so
      // the cap always reflects whichever monitor the window is currently
      // on, even if it was dragged to a different one since the last
      // content change.
      const monitor = await currentMonitor();
      const heightCap = monitor
        ? monitor.workArea.size.toLogical(monitor.scaleFactor).height * HEIGHT_CAP_FRACTION
        : FALLBACK_HEIGHT_CAP;

      const height = Math.min(heightCap, Math.max(minHeight, total));
      getCurrentWindow()
        .setSize(new LogicalSize(width, height))
        .catch((err) => console.error("useAutoResizeWindow: setSize failed", err));
    };

    const observer = new ResizeObserver(measure);
    const children = Array.from(el.children);
    children.forEach((child) => observer.observe(child));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, width, minHeight, enabled]);
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useAutoResizeWindow.test.tsx --exclude "**/.claude/**"`
Expected: all 8 tests pass.

- [x] **Step 6: Typecheck and full build**

Run: `bun run build`
Expected: clean. If TypeScript complains about assigning an `async` function (`measure`, which returns `Promise<void>`) to `ResizeObserverCallback` (which expects a `void`-returning function), this is a known-safe pattern TypeScript's structural typing explicitly allows for void-returning function positions — do not add an unnecessary wrapper like `() => { void measure(); }` unless the compiler actually errors; only add it if `bun run build` genuinely fails on this line.

- [x] **Step 7: Run the full frontend test suite to confirm no regressions elsewhere**

Run: `npx vitest run --exclude "**/.claude/**"`
Expected: every test file passes, with 3 more passing tests than before this task — `useAutoResizeWindow.test.tsx` goes from 5 tests to 8 (the 5 pre-existing tests are all still present, one of them now `async`, plus 3 new cap-behavior tests).

- [x] **Step 8: Commit**

```bash
git add src/hooks/useAutoResizeWindow.ts src/hooks/useAutoResizeWindow.test.tsx src-tauri/capabilities/default.json
git commit -m "feat: cap auto-resize window height to the current monitor's work area"
```

---

### Task 2: Fix the wrapper div so the cap cascades into working internal scroll — steps executed (commit `b9989ea`), but confirmed NOT to achieve this task's goal — see the banner at the top of this document

> **This task's code shipped, but does not do what it says.** The `overflow-hidden`
> change below was applied exactly as written and passed its own task-scoped review —
> but the final whole-branch reviewer proved empirically (headless Chrome, byte-identical
> DOM measurements with and without the change) that it has zero effect, because the
> premise in this task's own explanation ("this was the sole gap") is wrong: the
> `App.tsx` root has no height constraint in the non-pill state at all, so nothing ever
> reaches the point where `overflow-hidden` would matter. See the document-level banner
> for the full explanation and what actually needs to happen instead. Steps below are
> marked done in the sense that they were executed and committed, not in the sense that
> they achieved the task's stated goal.

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: nothing new from Task 1 — this task's fix is independent of Task 1's specific cap values, it just removes the CSS obstruction that would prevent ANY cap (of any value) from having a visible effect on the Done state's Tabs content.

- [x] **Step 1: Add `overflow-hidden` to the wrapper div**

In `src/App.tsx`, find this line (inside the full-chrome JSX, the wrapper between `TitleBar`/`ConfigDialog`/`ResumePrompt` and `<RecorderWidget>`):

```tsx
        <div className={isPill ? undefined : "flex-1 p-4"}>
```

Change it to:

```tsx
        <div className={isPill ? undefined : "flex-1 p-4 overflow-hidden"}>
```

This is the only change in this task. Per the design spec: this wrapper currently has no `overflow`/`min-height` handling, so per the CSS flexbox "automatic minimum size" rule it resists shrinking below its content's natural size even once Task 1's cap makes the window genuinely shorter than the content wants — `overflow-hidden` is the standard fix (the same mechanism already relied on by `RecorderWidget.tsx`'s `Tabs` element, which already has `flex-1 overflow-hidden`, and by each `TabsContent` panel, which already has `overflow-y-auto flex-1`). No other element in the chain needs a change — this was the sole gap.

- [x] **Step 2: Typecheck and full build**

Run: `bun run build`
Expected: clean (this is a className-only change, no logic).

- [x] **Step 3: Run the full frontend test suite to confirm no regressions**

Run: `npx vitest run --exclude "**/.claude/**"`
Expected: every test file passes, same count as after Task 1 (no test in this repo currently asserts on this specific wrapper's className, confirmed by grep before writing this plan — this step exists to catch any *other* regression, not because a specific test targets this line).

- [ ] **Step 4: Manual verification — not done (no display/Tauri runtime), and per the banner above, would have caught this task's fix not actually working**

Run: `bun run tauri dev` with a meeting that has a long transcript/summary (or temporarily lower `HEIGHT_CAP_FRACTION`/`FALLBACK_HEIGHT_CAP` in a local, uncommitted edit to force the cap to trigger on shorter content, for testing convenience — revert before committing if you do this).
Expected: the window stops growing once it reaches roughly 85% of the screen's usable height; the Summary/Actions/Transcript tab content becomes internally scrollable (a visible scrollbar, mouse-wheel/trackpad scroll works) instead of the window continuing to grow past that point; the title bar remains reachable and the window remains draggable to another connected monitor if one is available to test with.
If this cannot be run in the current environment (no display/Tauri runtime), say so explicitly in the task report rather than claiming it was checked — this is a known, standing limitation across this repo's UI work, not something to work around.

- [x] **Step 5: Commit — DONE (commit `b9989ea`)**

```bash
git add src/App.tsx
git commit -m "fix: let the Done state's internal scroll activate once the window height is capped"
```
