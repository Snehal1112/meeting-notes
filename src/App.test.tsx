import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import App from "./App";
import type { MeetingMeta } from "@/lib/storage";

type MockWidgetState = "idle" | "recording" | "processing";

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

vi.mock("@/lib/window", () => ({
  setClickThroughTracking: vi.fn().mockResolvedValue(undefined),
}));

// The real hook calls into Tauri's window APIs, which do not exist in
// jsdom, and is not under test here.
vi.mock("@/hooks/useAutoResizeWindow", () => ({ useAutoResizeWindow: vi.fn() }));

// Stubbed with real buttons (rather than a blank div) so these tests can
// drive App's showHistory/showConfigDialog wiring directly -- TitleBar's own
// click/drag behavior is already covered by TitleBar.test.tsx.
vi.mock("@/components/TitleBar", () => ({
  TitleBar: ({
    onOpenSettings,
    onOpenHistory,
  }: {
    onOpenSettings: () => void;
    onOpenHistory: () => void;
  }) => (
    <div>
      <button onClick={onOpenSettings}>open-settings</button>
      <button onClick={onOpenHistory}>open-history</button>
    </div>
  ),
}));

// Stubbed so these tests assert App's wiring (does showHistory swap in this
// component, does Back close it) without needing a real get_meeting_history
// Tauri call -- MeetingHistory's own data-loading behavior is covered by
// MeetingHistory.test.tsx.
const retryTarget: MeetingMeta = {
  id: "2026-08-02_110000_failed-meeting",
  title: "Failed meeting",
  created_at: "2026-08-02T11:00:00Z",
  duration_seconds: 120,
  status: "Failed",
  meeting_type: "AutoDetect",
  used_system_audio: true,
  error_message: "whisper.cpp exited with status 1",
};

vi.mock("@/components/MeetingHistory", () => ({
  MeetingHistory: ({
    onBack,
    onRetryMeeting,
    onContentChange,
  }: {
    onBack: () => void;
    onRetryMeeting?: (meeting: MeetingMeta) => void;
    onContentChange?: () => void;
  }) => (
    <div data-testid="history">
      <button onClick={onBack}>history-back</button>
      <button onClick={() => onRetryMeeting?.(retryTarget)}>retry-meeting</button>
      <button onClick={() => onContentChange?.()}>history-content-changed</button>
    </div>
  ),
}));

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
  error_message: null,
};

beforeEach(async () => {
  const { configNeedsSetup, getConfig } = await import("@/lib/config");
  vi.mocked(configNeedsSetup).mockReset().mockResolvedValue(false);
  vi.mocked(getConfig).mockReset().mockResolvedValue({
    claude_api_key: null,
    ollama_endpoint: null,
    ollama_model: null,
    ollama_num_ctx: null,
    summary_provider: null,
    whisper_model: null,
    data_dir: null,
  });

  const { getOrphanedMeetings, getDataDir } = await import("@/lib/storage");
  vi.mocked(getOrphanedMeetings).mockReset().mockResolvedValue([]);
  vi.mocked(getDataDir).mockReset().mockResolvedValue("/home/user/.local/share/meeting-notes");

  const { setClickThroughTracking } = await import("@/lib/window");
  vi.mocked(setClickThroughTracking).mockReset().mockResolvedValue(undefined);

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

  // The pill's fixed size and useAutoResizeWindow's content measurement are
  // two owners of the same OS window. The hook has to be switched off by its
  // `enabled` argument while the pill owns sizing -- merely detaching the ref
  // does not stop an already-created ResizeObserver, which then fights the
  // pill's resize animation frame by frame and wins (see
  // useAutoResizeWindow.test.tsx).
  it("disables content-driven sizing while the chrome-less pill owns the window", async () => {
    const { useAutoResizeWindow } = await import("@/hooks/useAutoResizeWindow");
    render(<App />);
    await screen.findByTestId("recorder");
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:false:0",
      undefined
    );

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      false,
      "recording:false:false:0",
      undefined
    );

    fireEvent.click(screen.getByRole("button", { name: "go-processing" }));
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      false,
      "processing:false:false:0",
      undefined
    );

    // Back out of the pill: the hook must be handed sizing again, or the
    // window would stay stuck at the pill's 224x56 on the Done/Idle screen.
    // widgetState is also passed as remeasureKey here -- distinct from
    // "recording"/"processing" above -- so this transition forces a fresh
    // measurement even though `enabled` alone doesn't change from the
    // previous idle->pill round trip (see useAutoResizeWindow.test.tsx's
    // "rebuilds the observer and re-measures when remeasureKey changes").
    fireEvent.click(screen.getByRole("button", { name: "go-idle" }));
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:false:0",
      undefined
    );
  });

  // Regression test: closing the (taller) ConfigDialog back to the
  // (shorter) RecorderWidget swaps the root's DOM children without
  // widgetState ever changing. Without showConfigDialog folded into
  // remeasureKey, the hook never tears down and re-measures, so the window
  // stays pinned at the config panel's height instead of shrinking back
  // down to fit the idle widget.
  it("forces a fresh measurement when the settings panel opens and closes", async () => {
    const { configNeedsSetup } = await import("@/lib/config");
    vi.mocked(configNeedsSetup).mockResolvedValue(true);
    const { useAutoResizeWindow } = await import("@/hooks/useAutoResizeWindow");

    render(<App />);
    await screen.findByText(/set up meeting notes/i);
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:true:false:0",
      undefined
    );

    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    await screen.findByTestId("recorder");
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:false:0",
      undefined
    );
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

describe("App meeting history", () => {
  it("hands the meeting to the widget and closes History when Retry is triggered", async () => {
    render(<App />);
    await screen.findByTestId("recorder");
    fireEvent.click(screen.getByRole("button", { name: "open-history" }));
    await screen.findByTestId("history");

    fireEvent.click(screen.getByRole("button", { name: "retry-meeting" }));

    expect(await screen.findByTestId("recorder")).toHaveTextContent(`resuming:${retryTarget.id}`);
    expect(screen.queryByTestId("history")).not.toBeInTheDocument();
  });

  it("shows Meeting History and hides the widget when the History icon is clicked", async () => {
    render(<App />);
    await screen.findByTestId("recorder");

    fireEvent.click(screen.getByRole("button", { name: "open-history" }));

    expect(await screen.findByTestId("history")).toBeInTheDocument();
    expect(screen.queryByTestId("recorder")).not.toBeInTheDocument();
  });

  it("returns to the widget when Meeting History's Back is clicked", async () => {
    render(<App />);
    await screen.findByTestId("recorder");
    fireEvent.click(screen.getByRole("button", { name: "open-history" }));
    await screen.findByTestId("history");

    fireEvent.click(screen.getByRole("button", { name: "history-back" }));

    expect(await screen.findByTestId("recorder")).toBeInTheDocument();
    expect(screen.queryByTestId("history")).not.toBeInTheDocument();
  });

  it("closes an open Settings panel when History is opened", async () => {
    const { configNeedsSetup } = await import("@/lib/config");
    vi.mocked(configNeedsSetup).mockResolvedValue(true);
    render(<App />);
    await screen.findByText(/set up meeting notes/i);

    fireEvent.click(screen.getByRole("button", { name: "open-history" }));

    expect(await screen.findByTestId("history")).toBeInTheDocument();
    expect(screen.queryByText(/set up meeting notes/i)).not.toBeInTheDocument();
  });

  it("closes an open History panel when Settings is opened", async () => {
    render(<App />);
    await screen.findByTestId("recorder");
    fireEvent.click(screen.getByRole("button", { name: "open-history" }));
    await screen.findByTestId("history");

    fireEvent.click(screen.getByRole("button", { name: "open-settings" }));

    expect(await screen.findByText(/set up meeting notes/i)).toBeInTheDocument();
    expect(screen.queryByTestId("history")).not.toBeInTheDocument();
  });

  it("caps the height at 600px while Meeting History is open", async () => {
    const { useAutoResizeWindow } = await import("@/hooks/useAutoResizeWindow");
    render(<App />);
    await screen.findByTestId("recorder");

    fireEvent.click(screen.getByRole("button", { name: "open-history" }));
    await screen.findByTestId("history");

    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:true:0",
      600
    );
  });

  // Regression test for the pagination-resize bug: MeetingHistory's own
  // internal state (pagination, search/filter, a row refreshed after
  // re-run) is invisible to App.tsx, so it has to be told explicitly via
  // onContentChange -- otherwise remeasureKey never changes once History is
  // already open, and the window stays pinned at whatever height it had
  // when History first rendered.
  it("forces a fresh measurement when MeetingHistory reports a content change", async () => {
    const { useAutoResizeWindow } = await import("@/hooks/useAutoResizeWindow");
    render(<App />);
    await screen.findByTestId("recorder");
    fireEvent.click(screen.getByRole("button", { name: "open-history" }));
    await screen.findByTestId("history");

    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:true:0",
      600
    );

    fireEvent.click(screen.getByRole("button", { name: "history-content-changed" }));

    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:true:1",
      600
    );
  });

  it("passes no height override once Meeting History is closed", async () => {
    const { useAutoResizeWindow } = await import("@/hooks/useAutoResizeWindow");
    render(<App />);
    await screen.findByTestId("recorder");
    fireEvent.click(screen.getByRole("button", { name: "open-history" }));
    await screen.findByTestId("history");

    fireEvent.click(screen.getByRole("button", { name: "history-back" }));

    expect(await screen.findByTestId("recorder")).toBeInTheDocument();
    expect(vi.mocked(useAutoResizeWindow)).toHaveBeenLastCalledWith(
      expect.anything(),
      400,
      300,
      true,
      "idle:false:false:0",
      undefined
    );
  });
});

describe("App click-through tracking", () => {
  it("activates click-through tracking when entering the Recording pill", async () => {
    const { setClickThroughTracking } = await import("@/lib/window");
    render(<App />);
    await screen.findByTestId("recorder");

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));

    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenCalledWith(true));
  });

  it("deactivates click-through tracking when returning to idle", async () => {
    const { setClickThroughTracking } = await import("@/lib/window");
    render(<App />);
    await screen.findByTestId("recorder");

    fireEvent.click(screen.getByRole("button", { name: "go-recording" }));
    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenCalledWith(true));

    fireEvent.click(await screen.findByRole("button", { name: "go-idle" }));
    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenLastCalledWith(false));
  });

  it("does not activate click-through tracking for the Idle state on initial render", async () => {
    const { setClickThroughTracking } = await import("@/lib/window");
    render(<App />);
    await screen.findByTestId("recorder");

    await vi.waitFor(() => expect(setClickThroughTracking).toHaveBeenCalledWith(false));
    expect(setClickThroughTracking).not.toHaveBeenCalledWith(true);
  });
});
