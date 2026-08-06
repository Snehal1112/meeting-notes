import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAutoResizeWindow } from "./useAutoResizeWindow";

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
  // A fixed "current window size" baseline, distinct from every test's
  // computed target height, so animations in this file exercise real
  // interpolation instead of trivially starting already-at-target.
  innerSize.mockReset().mockResolvedValue({ toLogical: () => ({ width: 400, height: 300 }) });
  scaleFactor.mockReset().mockResolvedValue(1);
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // jsdom's real requestAnimationFrame timestamps each callback with
  // `performance.now() - <time the jsdom window was constructed>`, not raw
  // performance.now() -- a different clock origin than animateResize's own
  // `performance.now()`-based `start` (see windowAnimation.ts). In a real
  // browser/webview these two share one origin, so this never surfaces
  // there; under Vitest's default parallel pool, workers are reused across
  // test files, so "time since this window was constructed" can already be
  // arbitrarily large by the time this file's tests run, corrupting
  // animateResize's elapsed-time math with a large, non-deterministic
  // offset. Rerouting through a real (but origin-consistent) setTimeout
  // keeps these tests' existing real-async/waitFor-based flow working while
  // eliminating that mismatch -- mirroring the fully-mocked rAF/performance
  // stand-in windowAnimation.test.ts already uses for the same function.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
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

  // Regression test for a stale-async-write bug: measure() is async (it
  // awaits currentMonitor(), a real Tauri IPC round-trip), so it can still be
  // suspended when the effect that started it is torn down. disconnect()ing
  // the observer in cleanup does not stop an already-in-flight measure()
  // call from resolving later and calling setSize() with a stale size.
  it("does not resize after being disabled mid-measure", async () => {
    let resolveMonitor: (m: null) => void;
    currentMonitor.mockReturnValue(
      new Promise((r) => {
        resolveMonitor = r;
      })
    );
    const { rerender } = renderHook(
      ({ enabled }) => useAutoResizeWindow(ref, 400, 300, enabled),
      { initialProps: { enabled: true } }
    );

    FakeResizeObserver.instances[0]!.fire(); // measure() suspends at the await
    rerender({ enabled: false }); // cleanup runs
    resolveMonitor!(null); // stale call resolves
    await Promise.resolve();

    expect(setSize).not.toHaveBeenCalled();
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

  // Regression test for the ratchet bug: a naive fix that reads
  // scrollHeight WHILE a previous pin is still applied will see that pin's
  // own (border-shrunk) value reflected back, and write an ever-smaller
  // height on every subsequent measurement instead of holding steady at
  // the cap. This models the real flex/overflow chain's behavior: once
  // `root.style.height` is set, the observed child's own box (and
  // therefore its scrollHeight) becomes exactly that pinned value minus a
  // fixed 2px (the root's top+bottom border) -- unless the measurement
  // code lifts the pin before reading, in which case this getter reports
  // the true natural content height instead.
  it("does not ratchet the height down across repeated measurements", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    const NATURAL_HEIGHT = 5000; // far exceeds the 850px cap (1000 * 0.85)

    Object.defineProperty(root.children[0]!, "scrollHeight", {
      configurable: true,
      get() {
        return root.style.height ? parseInt(root.style.height, 10) - 2 : NATURAL_HEIGHT;
      },
    });

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

  // Regression test for "New Recording doesn't shrink the window back down":
  // once the root's height is pinned (e.g. after a long Done-state
  // summary), swapping in much shorter content (e.g. returning to Idle)
  // never changes any observed element's own box size -- a pinned root's
  // flex-1 children stretch to FILL the stale pinned space rather than
  // shrinking to content -- so the existing ResizeObserver has nothing to
  // react to and the stale pin persists forever. `remeasureKey` lets the
  // caller (App.tsx, passing widgetState) force a fresh measurement on a
  // transition ResizeObserver can't detect on its own.
  it("rebuilds the observer and re-measures when remeasureKey changes", async () => {
    currentMonitor.mockResolvedValue(fakeMonitor(1000));
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 5000, configurable: true });

    const { rerender } = renderHook(
      ({ remeasureKey }) => useAutoResizeWindow(ref, 400, 300, true, remeasureKey),
      { initialProps: { remeasureKey: "done" } }
    );
    FakeResizeObserver.instances[0]!.fire();
    await waitFor(() => expect(root.style.height).toBe("850px"));

    // Simulate "New Recording": the DOM now shows much shorter content, but
    // nothing about any observed element's OWN box size has organically
    // changed (it's still stretched to fill the stale 850px pin) -- only
    // remeasureKey changes, exactly as App.tsx would do by passing widgetState.
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 80, configurable: true });
    rerender({ remeasureKey: "idle" });

    expect(FakeResizeObserver.instances).toHaveLength(2);
    FakeResizeObserver.instances[1]!.fire();

    await waitFor(() => expect(root.style.height).toBe("300px"));
  });

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

    // New, shorter content arrives mid-animation. 200 is below this hook's
    // own 300px minHeight floor (see the renderHook call above), so the
    // settled target clamps to 300 -- still a different, smaller target than
    // the first measurement's 500, which is all this test needs to exercise
    // cross-measurement cancellation.
    Object.defineProperty(root.children[0]!, "scrollHeight", { value: 200, configurable: true });
    // Snapshot the call count right before the second measurement starts, so
    // every assertion below can look at ALL calls from this point on -- not
    // just the last one. A last-call-only check cannot tell "the first
    // animation was truly cancelled" apart from "the first animation just
    // happened to finish naturally around the same time" -- both end with
    // the second animation's calls last, since it always starts (and so
    // finishes its own fixed 180ms duration) after the first. Only scanning
    // every call in between actually catches a leftover frame from an
    // uncancelled first animation still easing toward 500.
    const callsBeforeSecondFire = setSize.mock.calls.length;
    FakeResizeObserver.instances[0]!.fire();

    await waitFor(() =>
      expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 300 }))
    );

    // Give the cancelled first animation's remaining frames time to fire
    // (its full 180ms duration, generously padded) -- it must never
    // overwrite the second animation's settled value.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 300 }));

    // The real proof of cancellation: not one call made since the second
    // measurement started may carry the first animation's abandoned target
    // (500). If `isStale` were dropped from the `animateResize(...)` call in
    // useAutoResizeWindow.ts (reverting to the default no-op isCancelled),
    // the first animation would keep independently easing toward 500 on its
    // own schedule and its final frame -- which lands on exactly height:
    // 500 -- would show up somewhere in this range, regardless of what the
    // second animation does.
    const callsSinceSecondFire = setSize.mock.calls.slice(callsBeforeSecondFire);
    expect(callsSinceSecondFire.length).toBeGreaterThan(0);
    for (const call of callsSinceSecondFire) {
      expect((call[0] as { height: number }).height).not.toBeCloseTo(500, 0);
    }
  });
});
