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
});
