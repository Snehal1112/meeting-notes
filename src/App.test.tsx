import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import App from "./App";
import type { MeetingMeta } from "@/lib/storage";

vi.mock("@/lib/config", () => ({
  configNeedsSetup: vi.fn(),
  saveConfig: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  getOrphanedMeetings: vi.fn(),
  createNewMeeting: vi.fn(),
  updateMeetingStatus: vi.fn(),
  getDataDir: vi.fn(),
}));

// The real hook and title bar call into Tauri's window APIs, which do not
// exist in jsdom. Neither is under test here.
vi.mock("@/hooks/useAutoResizeWindow", () => ({ useAutoResizeWindow: vi.fn() }));
vi.mock("@/components/TitleBar", () => ({ TitleBar: () => <div /> }));

// Stubbed so these tests assert App's wiring — which meeting it hands down —
// rather than re-testing the widget's own recording flow.
vi.mock("@/components/RecorderWidget", () => ({
  RecorderWidget: ({ resumeMeeting }: { resumeMeeting?: MeetingMeta | null }) => (
    <div data-testid="recorder">{resumeMeeting ? `resuming:${resumeMeeting.id}` : "idle"}</div>
  ),
}));

const orphan: MeetingMeta = {
  id: "2026-08-02_090000_standup",
  title: "Standup",
  created_at: "2026-08-02T09:00:00Z",
  duration_seconds: null,
  status: "Recording",
  used_system_audio: true,
};

beforeEach(async () => {
  const { configNeedsSetup } = await import("@/lib/config");
  vi.mocked(configNeedsSetup).mockReset().mockResolvedValue(false);

  const { getOrphanedMeetings } = await import("@/lib/storage");
  vi.mocked(getOrphanedMeetings).mockReset().mockResolvedValue([]);
});

describe("App orphaned recording recovery", () => {
  it("shows the resume prompt when an interrupted recording is found", async () => {
    const { getOrphanedMeetings } = await import("@/lib/storage");
    vi.mocked(getOrphanedMeetings).mockResolvedValue([orphan]);

    render(<App />);
    expect(await screen.findByText(/interrupted recording/i)).toBeInTheDocument();
    expect(screen.getByText(/standup/i)).toBeInTheDocument();
  });

  it("shows no prompt when there is nothing to resume", async () => {
    render(<App />);
    expect(await screen.findByTestId("recorder")).toHaveTextContent("idle");
    expect(screen.queryByText(/interrupted recording/i)).not.toBeInTheDocument();
  });

  it("hands the meeting to the widget and hides the prompt on Resume", async () => {
    const { getOrphanedMeetings } = await import("@/lib/storage");
    vi.mocked(getOrphanedMeetings).mockResolvedValue([orphan]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /resume/i }));

    expect(await screen.findByTestId("recorder")).toHaveTextContent(`resuming:${orphan.id}`);
    expect(screen.queryByText(/interrupted recording/i)).not.toBeInTheDocument();
  });

  it("hides the prompt without resuming on Dismiss", async () => {
    const { getOrphanedMeetings } = await import("@/lib/storage");
    vi.mocked(getOrphanedMeetings).mockResolvedValue([orphan]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(/interrupted recording/i)).not.toBeInTheDocument();
    expect(await screen.findByTestId("recorder")).toHaveTextContent("idle");
  });

  // The first-launch config panel replaces the widget entirely, so surfacing
  // a resume prompt behind it would offer an action the user cannot complete.
  it("does not show the resume prompt while the config dialog is up", async () => {
    const { configNeedsSetup } = await import("@/lib/config");
    const { getOrphanedMeetings } = await import("@/lib/storage");
    vi.mocked(configNeedsSetup).mockResolvedValue(true);
    vi.mocked(getOrphanedMeetings).mockResolvedValue([orphan]);

    render(<App />);
    expect(await screen.findByText(/set up meeting notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/interrupted recording/i)).not.toBeInTheDocument();
  });

  // A failed index read must not take the whole app down with it; the user
  // can still record even if orphan detection is unavailable.
  it("still renders the widget when orphan detection fails", async () => {
    const { getOrphanedMeetings } = await import("@/lib/storage");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getOrphanedMeetings).mockRejectedValue(new Error("index.json unreadable"));

    render(<App />);
    expect(await screen.findByTestId("recorder")).toHaveTextContent("idle");
    consoleErrorSpy.mockRestore();
  });
});
