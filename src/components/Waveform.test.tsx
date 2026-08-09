import { render } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Waveform, easeTowards, colorForIntensity } from "./Waveform";

describe("Waveform", () => {
  it("renders a canvas element", () => {
    const { container } = render(<Waveform active={false} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

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

// Nothing above proves the draw loop itself actually calls easeTowards /
// colorForIntensity, draws bars (vs. dots), or eases motion at all --
// someone could revert `displayed[i] = easeTowards(...)` back to raw values
// and every test above would still pass green. This drives one real frame
// through the effect's setup()/getUserMedia/AudioContext/draw() chain, with
// jsdom's missing browser APIs (canvas 2D context, getUserMedia,
// AudioContext) stubbed by hand -- no existing test file in this repo mocks
// these, so the shape below is new, not reused from elsewhere.
describe("Waveform draw loop", () => {
  const FREQUENCY_BIN_COUNT = 4;

  let ctx: {
    clearRect: ReturnType<typeof vi.fn>;
    beginPath: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    lineWidth: number;
    lineCap: string;
    strokeStyle: string;
  };
  let getContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mock 2D context: spies for the methods the draw loop calls, writable
    // properties for the state it sets.
    ctx = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      lineWidth: 0,
      lineCap: "",
      strokeStyle: "",
    };
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);

    // requestAnimationFrame is stubbed to capture rather than run the
    // callback, so only one frame ever gets drawn -- the component's own
    // draw() calls itself synchronously the first time (not via rAF), so
    // this stub only needs to stop a *second* frame from firing.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    // Fake analyser: a small fixed bin count, and every sample maxed out
    // (255) so the raw target intensity is always 1.0 -- this is what makes
    // the smoothing assertion meaningful (see the test below).
    const fakeAnalyser = {
      fftSize: 0,
      frequencyBinCount: FREQUENCY_BIN_COUNT,
      getByteFrequencyData: vi.fn((array: Uint8Array) => array.fill(255)),
    };
    const fakeSource = { connect: vi.fn() };
    class FakeAudioContext {
      createMediaStreamSource = vi.fn(() => fakeSource);
      createAnalyser = vi.fn(() => fakeAnalyser);
      close = vi.fn();
    }
    // Waveform.tsx only references the unprefixed global AudioContext (no
    // webkitAudioContext fallback), so only this needs stubbing.
    vi.stubGlobal("AudioContext", FakeAudioContext);

    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    getContextSpy.mockRestore();
    vi.unstubAllGlobals();
    // @ts-expect-error -- undo the test-only navigator.mediaDevices stub; jsdom doesn't define it by default.
    delete navigator.mediaDevices;
  });

  it("draws one bar per frequency bin using the eased mid-intensity color on the first frame", async () => {
    render(<Waveform active />);

    // Flush the getUserMedia await and the rest of setup() through to its
    // first, synchronous draw() call, without racing real timers.
    await vi.waitFor(() => expect(ctx.stroke).toHaveBeenCalled());

    // One stroked bar per frequency bin -- proves bars (not dots) are drawn
    // per-bin.
    expect(ctx.stroke).toHaveBeenCalledTimes(FREQUENCY_BIN_COUNT);
    expect(ctx.lineCap).toBe("round");
    // Raw intensity is 1.0 (every sample maxed at 255), but displayed[i]
    // starts at 0 and eases only SMOOTHING_FACTOR (0.35) of the way there on
    // this first frame -- 0.35 is still inside colorForIntensity's mid band
    // (< 0.5), so the recorded stroke color must be amber, not the
    // destructive/red color reachable only once displayed[i] actually
    // climbs to raw over several frames. A regression back to raw
    // (unsmoothed) values would show red here instead.
    expect(ctx.strokeStyle).toBe("#F59E0B");
  });
});
