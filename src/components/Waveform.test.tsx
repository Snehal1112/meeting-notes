import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Waveform } from "./Waveform";

describe("Waveform", () => {
  it("renders a canvas element", () => {
    const { container } = render(<Waveform active={false} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });
});
