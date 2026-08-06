import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TitleBar } from "./TitleBar";

const close = vi.fn(() => Promise.resolve());
const startDragging = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close, startDragging }),
}));

beforeEach(() => {
  close.mockClear();
  startDragging.mockClear();
});

describe("TitleBar", () => {
  it("closes the window when the close button is clicked", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(close).toHaveBeenCalled();
  });

  it("does not start a window drag when the close button is pressed", () => {
    render(<TitleBar />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /close/i }));
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("still starts a window drag when the background is pressed", () => {
    render(<TitleBar />);
    const dragRegion = document.querySelector("[data-tauri-drag-region]")!;
    fireEvent.mouseDown(dragRegion);
    expect(startDragging).toHaveBeenCalled();
  });
});
