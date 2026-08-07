import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MeetingHistory } from "./MeetingHistory";
import type { MeetingHistoryEntry } from "@/lib/history";

const getMeetingHistory = vi.fn();

vi.mock("@/lib/history", () => ({
  getMeetingHistory: () => getMeetingHistory(),
  deleteMeeting: vi.fn(),
  revealInFileManager: vi.fn(),
}));

const entry = (overrides: Partial<MeetingHistoryEntry> = {}): MeetingHistoryEntry => ({
  id: "2026-08-02_090000_standup",
  title: "Standup",
  created_at: "2026-08-02T09:00:00Z",
  duration_seconds: 600,
  status: "Done",
  used_system_audio: true,
  meeting_type: "AutoDetect",
  error_message: null,
  snippet: "Shipped the roadmap.",
  ...overrides,
});

describe("MeetingHistory", () => {
  it("shows a loading state before the history resolves", () => {
    getMeetingHistory.mockReturnValue(new Promise(() => {}));
    render(<MeetingHistory onBack={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an empty state with no search/filter bar when there are no meetings", async () => {
    getMeetingHistory.mockResolvedValue([]);
    render(<MeetingHistory onBack={() => {}} />);

    expect(await screen.findByText(/no meetings yet/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it("does not show the empty state once meetings load", async () => {
    getMeetingHistory.mockResolvedValue([entry()]);
    render(<MeetingHistory onBack={() => {}} />);

    await vi.waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/no meetings yet/i)).not.toBeInTheDocument();
  });

  it("calls onBack when the back button is clicked", async () => {
    getMeetingHistory.mockResolvedValue([]);
    const onBack = vi.fn();
    render(<MeetingHistory onBack={onBack} />);

    fireEvent.click(await screen.findByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
