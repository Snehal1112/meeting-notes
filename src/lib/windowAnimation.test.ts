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
    // @ts-expect-error - vitest mock.calls type narrowing
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
