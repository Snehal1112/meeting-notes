import { fireEvent, render, screen } from "@testing-library/react";
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

describe("RecorderWidget recording state", () => {
  it("calls startRecording and shows the recording state on Start click", async () => {
    const { startRecording } = await import("@/lib/recording");
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(startRecording).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeInTheDocument();
  });
});
