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
    render(<TitleBar onOpenSettings={() => {}} onOpenHistory={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(close).toHaveBeenCalled();
  });

  it("does not start a window drag when the close button is pressed", () => {
    render(<TitleBar onOpenSettings={() => {}} onOpenHistory={() => {}} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /close/i }));
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("still starts a window drag when the background is pressed", () => {
    render(<TitleBar onOpenSettings={() => {}} onOpenHistory={() => {}} />);
    const dragRegion = document.querySelector("[data-tauri-drag-region]")!;
    fireEvent.mouseDown(dragRegion);
    expect(startDragging).toHaveBeenCalled();
  });

  it("calls onOpenSettings when the settings button is clicked", () => {
    const onOpenSettings = vi.fn();
    render(<TitleBar onOpenSettings={onOpenSettings} onOpenHistory={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("does not start a window drag when the settings button is pressed", () => {
    render(<TitleBar onOpenSettings={() => {}} onOpenHistory={() => {}} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /settings/i }));
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("calls onOpenHistory when the history button is clicked", () => {
    const onOpenHistory = vi.fn();
    render(<TitleBar onOpenSettings={() => {}} onOpenHistory={onOpenHistory} />);
    fireEvent.click(screen.getByRole("button", { name: /meeting history/i }));
    expect(onOpenHistory).toHaveBeenCalled();
  });

  it("does not start a window drag when the history button is pressed", () => {
    render(<TitleBar onOpenSettings={() => {}} onOpenHistory={() => {}} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /meeting history/i }));
    expect(startDragging).not.toHaveBeenCalled();
  });
});
