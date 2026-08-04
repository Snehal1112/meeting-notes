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
