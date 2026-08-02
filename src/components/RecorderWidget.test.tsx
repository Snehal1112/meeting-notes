import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RecorderWidget } from "./RecorderWidget";

vi.mock("@/lib/recording", () => ({
  startRecording: vi.fn().mockResolvedValue(true),
  stopRecording: vi.fn().mockResolvedValue("/tmp/audio.wav"),
}));

describe("RecorderWidget idle state", () => {
  it("shows a title input and Start Recording button by default", () => {
    render(<RecorderWidget />);
    expect(screen.getByPlaceholderText(/meeting title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });
});
