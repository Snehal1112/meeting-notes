import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MeetingHistoryRow } from "./MeetingHistoryRow";
import type { MeetingHistoryEntry } from "@/lib/history";

const entry = (overrides: Partial<MeetingHistoryEntry> = {}): MeetingHistoryEntry => ({
  id: "2026-08-02_090000_standup",
  title: "Standup",
  created_at: "2026-08-02T09:00:00Z",
  duration_seconds: 605,
  status: "Done",
  used_system_audio: true,
  meeting_type: "Retrospective",
  error_message: null,
  snippet: "Shipped the roadmap.",
  ...overrides,
});

function renderRow(overrides: Partial<MeetingHistoryEntry> = {}, handlers: Partial<{
  onOpen: () => void;
  onReveal: () => void;
  onRerun: () => void;
  onRetry: () => void;
  onDelete: () => void;
}> = {}) {
  const props = {
    onOpen: vi.fn(),
    onReveal: vi.fn(),
    onRerun: vi.fn(),
    onRetry: vi.fn(),
    onDelete: vi.fn(),
    ...handlers,
  };
  render(<MeetingHistoryRow entry={entry(overrides)} {...props} />);
  return props;
}

describe("MeetingHistoryRow", () => {
  it("renders the title, meeting type, and status", () => {
    renderRow();
    expect(screen.getByText("Standup")).toBeInTheDocument();
    expect(screen.getByText("Retrospective")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("falls back to 'Untitled meeting' when the title is empty", () => {
    renderRow({ title: "" });
    expect(screen.getByText("Untitled meeting")).toBeInTheDocument();
  });

  it("calls onOpen when the title is clicked", () => {
    const { onOpen } = renderRow();
    fireEvent.click(screen.getByText("Standup"));
    expect(onOpen).toHaveBeenCalled();
  });

  it("shows the snippet for a Done meeting", () => {
    renderRow({ status: "Done", snippet: "Shipped the roadmap." });
    expect(screen.getByText("Shipped the roadmap.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("shows the error message and a Retry button for a Failed meeting instead of a snippet", () => {
    const { onRetry } = renderRow({
      status: "Failed",
      snippet: null,
      error_message: "whisper.cpp exited with status 1",
    });

    expect(screen.getByText("whisper.cpp exited with status 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("opens the actions menu and calls onReveal for Reveal in file manager", async () => {
    const user = userEvent.setup();
    const { onReveal } = renderRow();

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByText(/reveal in file manager/i));

    expect(onReveal).toHaveBeenCalled();
  });

  it("shows Re-run summarization for a Done meeting and calls onRerun", async () => {
    const user = userEvent.setup();
    const { onRerun } = renderRow({ status: "Done" });

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByText(/re-run summarization/i));

    expect(onRerun).toHaveBeenCalled();
  });

  it("does not show Re-run summarization for a Failed meeting", async () => {
    const user = userEvent.setup();
    renderRow({ status: "Failed", snippet: null, error_message: "boom" });

    await user.click(screen.getByRole("button", { name: /actions/i }));

    expect(screen.queryByText(/re-run summarization/i)).not.toBeInTheDocument();
  });

  it("calls onDelete when Delete is clicked", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderRow();

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByText(/^delete$/i));

    expect(onDelete).toHaveBeenCalled();
  });
});
