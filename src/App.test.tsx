import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import App from "./App";
import type { MeetingMeta } from "@/lib/storage";

type MockWidgetState = "idle" | "recording" | "processing" | "done";

// Bumped once per genuine RecorderWidget *mount* (see idRef below) --
// distinct from a re-render of an already-mounted instance. Used by the
// "keeps RecorderWidget mounted" tests below to detect the App.tsx bug where
// swapping between the chrome-less pill branch and the full-chrome branch
// put RecorderWidget at a different position/depth in the tree, causing
// React to tear down and remount it on every idle<->recording/processing
// transition instead of preserving the instance.
let recorderMountCount = 0;

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

// Stubbed so these tests assert App's wiring — which meeting it hands down,
// and (below) whether App preserves this instance across a widgetState
// transition — rather than re-testing the widget's own recording flow.
// idRef is assigned lazily on first render and never reassigned after that:
// it stays put across re-renders of the same instance, but a genuine remount
// creates a fresh ref (starting at null again), which is exactly the
// distinction the mount-tracking tests below need.
vi.mock("@/components/RecorderWidget", () => ({
  RecorderWidget: ({
    resumeMeeting,
    onStateChange,
  }: {
    resumeMeeting?: MeetingMeta | null;
    onStateChange?: (state: MockWidgetState) => void;
  }) => {
    const idRef = useRef<number | null>(null);
    if (idRef.current === null) {
      recorderMountCount += 1;
      idRef.current = recorderMountCount;
    }
    return (
      <div data-testid="recorder">
        <span data-testid="recorder-mount-id">{idRef.current}</span>
        {resumeMeeting ? `resuming:${resumeMeeting.id}` : "idle"}
        <button onClick={() => onStateChange?.("recording")}>go-recording</button>
        <button onClick={() => onStateChange?.("processing")}>go-processing</button>
        <button onClick={() => onStateChange?.("idle")}>go-idle</button>
      </div>
    );
  },
}));

const orphan: MeetingMeta = {
  id: "2026-08-02_090000_standup",
  title: "Standup",
  created_at: "2026-08-02T09:00:00Z",
  duration_seconds: null,
  status: "Recording",
  meeting_type: "AutoDetect",
  used_system_audio: true,
};

beforeEach(async () => {
  const { configNeedsSetup } = await import("@/lib/config");
  vi.mocked(configNeedsSetup).mockReset().mockResolvedValue(false);

  const { getOrphanedMeetings } = await import("@/lib/storage");
  vi.mocked(getOrphanedMeetings).mockReset().mockResolvedValue([]);

  recorderMountCount = 0;
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

// App renders two very different sets of chrome depending on widgetState:
// full chrome (TitleBar/ConfigDialog/ResumePrompt) for idle/done, and a bare
// chrome-less pill for recording/processing. RecorderWidget itself reports
// these transitions via onStateChange (see RecorderWidget.tsx), which means
// App re-renders with a differently-shaped tree the instant a recording
// starts or transcription finishes. If RecorderWidget's own JSX element
// isn't kept at the same position in that tree across both shapes, React
// tears down and remounts it — silently dropping its internal state (the
// elapsed-time timer, currentMeetingRef, the live transcription listener)
// right as a real recording/transcription is in flight.
//
// animateResize's window calls (getCurrentWindow() and friends) throw
// synchronously outside a real Tauri runtime; App.tsx already logs and
// swallows that failure rather than letting it escape, which is what keeps
// these tests able to trigger a real "recording"/"processing" transition in
// jsdom without a Tauri backend.
describe("App keeps RecorderWidget mounted across chrome transitions", () => {
  it("preserves the RecorderWidget instance when it reports moving into the chrome-less recording pill", async () => {
    render(<App />);
    const beforeId = (await screen.findByTestId("recorder-mount-id")).textContent;

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));

    // Same instance, not a fresh mount: the id assigned on first render must
    // still read back after the chrome swap.
    expect(await screen.findByTestId("recorder-mount-id")).toHaveTextContent(beforeId!);
    expect(recorderMountCount).toBe(1);
  });

  it("preserves the RecorderWidget instance across recording -> processing -> idle", async () => {
    render(<App />);
    const beforeId = (await screen.findByTestId("recorder-mount-id")).textContent;

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));
    fireEvent.click(await screen.findByRole("button", { name: "go-processing" }));
    fireEvent.click(await screen.findByRole("button", { name: "go-idle" }));

    expect(await screen.findByTestId("recorder-mount-id")).toHaveTextContent(beforeId!);
    expect(recorderMountCount).toBe(1);
  });
});
