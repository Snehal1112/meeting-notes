# Done-State Internal Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `useAutoResizeWindow`'s root element a real, explicit height so the Done state's already-present `overflow-y-auto` Tabs content actually scrolls once the 85% height cap is hit, instead of silently overflowing past the window's visible edge.

**Architecture:** `useAutoResizeWindow`'s `measure()` already computes `height = Math.min(cap, Math.max(minHeight, total))` before calling `setSize()`. This plan adds one line right after that computation — `el.style.height = \`${height}px\`` — applied to the observed root element, plus a cleanup reset (`el.style.height = ""`) so the value doesn't leak onto the same DOM node when the hook is later disabled for pill mode. See `docs/superpowers/specs/2026-08-04-done-state-internal-scroll-design.md` for the full rationale, including why this avoids the circular-measurement trap that broke the previous attempt.

**Tech Stack:** React 19, TypeScript, Tauri v2 (`@tauri-apps/api/window`), Vitest + Testing Library.

## Global Constraints

- `HEIGHT_CAP_FRACTION` (0.85) and `FALLBACK_HEIGHT_CAP` (700 logical px) are unchanged — this plan only adds a DOM side effect to the existing calculation, never touches the numbers themselves.
- The explicit height applied to the DOM must always be a plain pixel value computed in JS from the same `height` variable already used for `setSize()` — never a viewport-relative CSS unit (`vh`, `h-screen`, or a `%` cascading from one) anywhere in the measured subtree, since that would make `total`'s reading of `scrollHeight` circular (see design doc "Why the obvious fix risks breaking measurement").
- No changes to `App.tsx` or `RecorderWidget.tsx` — both are already correct per the design doc (confirmed against current source during brainstorming, not assumed from the old design doc).
- `useAutoResizeWindow`'s exported signature (`(ref, width, minHeight, enabled?)`) is unchanged.

---

### Task 1: Apply and clean up an explicit computed height in useAutoResizeWindow

**Files:**
- Modify: `src/hooks/useAutoResizeWindow.ts`
- Modify: `src/hooks/useAutoResizeWindow.test.tsx`

**Interfaces:**
- Consumes: nothing new — this task only adds a DOM side effect inside the existing `measure()` function and the existing cleanup function, using the `height`, `el`, and `enabled` values already in scope.
- Produces: nothing new for other files to consume — `App.tsx` and `RecorderWidget.tsx` need no changes, since their `overflow-hidden`/`overflow-y-auto`/`flex-1`/`h-full` classes are already in place and were inert only for lack of a real height to resolve against.

- [ ] **Step 1: Write the failing tests**

Add these four tests to `src/hooks/useAutoResizeWindow.test.tsx`, inside the existing `describe("useAutoResizeWindow", ...)` block, immediately after the `"is unaffected by the cap when content is shorter than it"` test (i.e., as the last tests before the closing `});` of the `describe` block). Do not change anything else in the file.

```tsx
  it("sets an explicit pixel height on the root element after measuring", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 500, configurable: true });

    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() => expect(root.style.height).toBe("500px"));
  });

  it("caps the root element's explicit height the same way it caps setSize", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    // Content taller than the cap: make the single child's scrollHeight
    // exceed 850 (1000 * 0.85) so the cap -- not the content height -- wins,
    // exactly mirroring the existing "caps the height..." setSize test above.
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 5000, configurable: true });

    renderHook(() => useAutoResizeWindow(ref, 400, 300, true));
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() => expect(root.style.height).toBe("850px"));
  });

  it("clears the explicit height when the hook becomes disabled", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 500, configurable: true });

    const { rerender } = renderHook(({ enabled }) => useAutoResizeWindow(ref, 400, 300, enabled), {
      initialProps: { enabled: true },
    });
    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() => expect(root.style.height).toBe("500px"));

    // Regression guard for App.tsx's pill <-> full-chrome transition: rootRef's
    // div is reused (not remounted) across that transition, so a leftover
    // forced height here would otherwise fight the pill's own h-screen sizing.
    rerender({ enabled: false });

    expect(root.style.height).toBe("");
  });

  it("clears the explicit height on unmount", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 500, configurable: true });

    const { unmount } = renderHook(() => useAutoResizeWindow(ref, 400, 300, true));
    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() => expect(root.style.height).toBe("500px"));

    unmount();

    expect(root.style.height).toBe("");
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/hooks/useAutoResizeWindow.test.tsx --exclude "**/.claude/**"`
Expected: the 4 new tests fail (`root.style.height` is never set today, so it stays `""` even after `fire()`); all 8 pre-existing tests still pass.

- [ ] **Step 3: Implement the explicit height application and cleanup**

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

    // measure() awaits a real Tauri IPC round-trip (currentMonitor()), so it
    // can still be suspended when this effect run is torn down -- e.g. the
    // widget leaves Idle/Done for the Recording/Processing pill mid-measure.
    // `cancelled` stops a torn-down run from writing a stale size after the
    // fact; `latestRun` stops an older in-flight measure() from clobbering a
    // newer one if the ResizeObserver fires twice before the first resolves
    // (out-of-order resolution). Both are needed -- they guard different
    // failure modes.
    let cancelled = false;
    let latestRun = 0;

    const measure = async () => {
      const run = ++latestRun;

      // el's own scrollHeight is unreliable here: it's a flex-col container
      // with overflow-hidden, and its children (e.g. a scrollable panel) can
      // themselves be clipped to whatever height the window currently is,
      // understating how much content actually needs. Sum each direct
      // child's natural scrollHeight instead -- that's the real total. This
      // reading happens before any height is applied below, so it always
      // reflects the DOM's natural, unconstrained size.
      const total = Array.from(el.children).reduce(
        (sum, child) => sum + child.scrollHeight,
        0
      );

      // Queried fresh on every measure() call (not cached across renders) so
      // the cap always reflects whichever monitor the window is currently
      // on, even if it was dragged to a different one since the last
      // content change.
      const monitor = await currentMonitor();

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
      // just sent to the OS window -- deliberately never a viewport-relative
      // unit (100vh/h-screen), which would make `total` above circular (the
      // content's own layout would depend on the window size this
      // measurement is trying to compute). Plain pixels are safe here
      // because `total` is always read from `scrollHeight`, which reports an
      // element's true content extent regardless of whatever height that
      // same element currently has imposed on it -- that's the whole
      // difference between `scrollHeight` and `clientHeight`. This is what
      // lets RecorderWidget.tsx's already-present `overflow-y-auto` Tabs
      // content actually activate once content exceeds the cap, instead of
      // silently overflowing past the window's visible edge.
      el.style.height = `${height}px`;
    };

    const observer = new ResizeObserver(measure);
    const children = Array.from(el.children);
    children.forEach((child) => observer.observe(child));
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      // rootRef's div is reused (not remounted) across pill <-> full-chrome
      // transitions in App.tsx -- the ref/className on that element merely
      // toggle via a ternary. Without this reset, a height forced by a
      // capped Done state would linger on the same DOM node and fight the
      // pill's own `h-screen w-screen` sizing the next time this hook is
      // re-enabled.
      el.style.height = "";
    };
  }, [ref, width, minHeight, enabled]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useAutoResizeWindow.test.tsx --exclude "**/.claude/**"`
Expected: all 13 tests pass (9 pre-existing + 4 new).

- [ ] **Step 5: Typecheck and full build**

Run: `bun run build`
Expected: clean.

- [ ] **Step 6: Run the full frontend test suite to confirm no regressions**

Run: `npx vitest run --exclude "**/.claude/**"`
Expected: every test file passes, with 4 more passing tests than before this task.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useAutoResizeWindow.ts src/hooks/useAutoResizeWindow.test.tsx
git commit -m "fix: give the Done state's internal scroll a real height to activate against"
```

- [ ] **Step 8: Manual verification (this is the actual acceptance test — do not skip or mark done without running it)**

In the already-running `bun run tauri dev`, open (or resume) a meeting with a long summary/transcript — one that previously reproduced the bug (grows taller than the screen with no way to reach "Save & Close"). Confirm:
1. The window still stops growing at the same point as before this change (the 85% cap still works — this change must not regress Task 1 of the prior plan).
2. The current tab's content (Summary/Actions/Transcript) is now internally scrollable: a scrollbar appears, and mouse-wheel/trackpad scroll moves the content within that tab.
3. The header (title/attendees) above the Tabs and the Save & Close / New Recording controls remain visible and reachable without resizing the window.
4. Switching between tabs and a short (under-cap) meeting's Done state still look pixel-identical to before this change (this is the designed no-op case).

If any of these fail, do not mark this task complete — return to the design doc's "Why the obvious fix risks breaking measurement" section and re-diagnose before attempting another change, per this repo's systematic-debugging discipline.
