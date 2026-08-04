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
