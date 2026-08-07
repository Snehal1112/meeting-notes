import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecorderWidget } from "./RecorderWidget";
import type { MeetingMeta } from "@/lib/storage";

vi.mock("@/lib/recording", () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  createNewMeeting: vi.fn(),
  updateMeetingStatus: vi.fn(),
  getOrphanedMeetings: vi.fn(),
  getDataDir: vi.fn(),
  openSummary: vi.fn(),
}));

vi.mock("@/lib/transcription", () => ({
  transcribeMeeting: vi.fn(),
  onTranscriptionComplete: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  setSummaryProvider: vi.fn(),
}));

vi.mock("@/lib/summary", async (importOriginal) => {
  // resolveProvider (and the toProviderKind it uses internally) are pure
  // config-resolution logic (no Tauri invoke), so the real implementation
  // is used here — only summarizeMeeting (the actual IPC call) needs
  // mocking.
  const actual = await importOriginal<typeof import("@/lib/summary")>();
  return {
    ...actual,
    summarizeMeeting: vi.fn(),
  };
});

const fakeMeeting = {
  id: "2026-08-02_120000_test-meeting",
  title: "Test meeting",
  created_at: "2026-08-02T12:00:00Z",
  duration_seconds: null,
  status: "Recording" as const,
  used_system_audio: false,
  meeting_type: "AutoDetect" as const,
  error_message: null,
};

beforeEach(async () => {
  const { startRecording, stopRecording } = await import("@/lib/recording");
  vi.mocked(startRecording).mockReset().mockResolvedValue(true);
  vi.mocked(stopRecording)
    .mockReset()
    .mockResolvedValue({ output_path: "/tmp/audio.wav", quality_warning: null });

  const { createNewMeeting, updateMeetingStatus, getDataDir, openSummary } =
    await import("@/lib/storage");
  vi.mocked(createNewMeeting).mockReset().mockResolvedValue(fakeMeeting);
  vi.mocked(updateMeetingStatus).mockReset().mockResolvedValue(undefined);
  vi.mocked(getDataDir).mockReset().mockResolvedValue("/home/user/.local/share/meeting-notes");
  vi.mocked(openSummary).mockReset().mockResolvedValue(undefined);

  const { transcribeMeeting, onTranscriptionComplete } = await import("@/lib/transcription");
  vi.mocked(transcribeMeeting).mockReset().mockResolvedValue(undefined);
  vi.mocked(onTranscriptionComplete).mockReset().mockResolvedValue(() => {});

  const { summarizeMeeting } = await import("@/lib/summary");
  vi.mocked(summarizeMeeting).mockReset().mockResolvedValue({
    meeting_type: "Team sync",
    attendees: [],
    referenced_people: [],
    summary: "Discussed the roadmap.",
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
  });

  const { getConfig, saveConfig, setSummaryProvider } = await import("@/lib/config");
  vi.mocked(getConfig).mockReset().mockResolvedValue({
    claude_api_key: null,
    ollama_endpoint: null,
    ollama_model: null,
    ollama_num_ctx: null,
    summary_provider: null,
    whisper_model: "base.en",
    data_dir: null,
  });
  vi.mocked(saveConfig).mockReset().mockResolvedValue(undefined);
  vi.mocked(setSummaryProvider).mockReset().mockResolvedValue(undefined);
});

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
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeInTheDocument();
    expect(startRecording).toHaveBeenCalled();
  });
});

// App.tsx decides the entire window shape -- chrome vs. chrome-less pill, and
// which sizing owner runs -- purely from this callback (see App.test.tsx).
// Every other test of that wiring goes through a *mocked* RecorderWidget, so
// nothing else proves the real component actually reports its transitions.
describe("RecorderWidget onStateChange reporting", () => {
  it("reports every state it moves through, in order", async () => {
    const onStateChange = vi.fn();
    render(<RecorderWidget onStateChange={onStateChange} />);

    // Reported on mount, before anything happens: App needs the initial
    // value to pick a starting window shape.
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith("idle"));

    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await screen.findByRole("button", { name: /stop recording/i });
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith("recording"));

    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalledWith("processing"));

    // Order matters as much as membership: App animates the window between
    // fixed pill sizes on these transitions, so "processing" arriving before
    // "recording" would drive the wrong animation.
    const reported = onStateChange.mock.calls.map(([state]) => state);
    expect(reported.filter((state, i) => state !== reported[i - 1])).toEqual([
      "idle",
      "recording",
      "processing",
    ]);
  });

  it("reports the return to idle when a stop failure bounces the widget back", async () => {
    const { stopRecording } = await import("@/lib/recording");
    vi.mocked(stopRecording).mockRejectedValueOnce(new Error("no active recording"));
    const onStateChange = vi.fn();
    render(<RecorderWidget onStateChange={onStateChange} />);

    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await screen.findByRole("alert");

    // stopRecording rejecting never reaches setState("processing"); the
    // catch sends the widget straight back to "idle". App has to hear that
    // or the window stays stuck at the recording pill's size.
    const reported = onStateChange.mock.calls.map(([state]) => state);
    expect(reported[reported.length - 1]).toBe("idle");
    expect(reported).toContain("recording");
  });
});

describe("RecorderWidget error handling", () => {
  it("stays on idle and shows an error when startRecording rejects", async () => {
    const { startRecording } = await import("@/lib/recording");
    vi.mocked(startRecording).mockRejectedValueOnce(new Error("already recording"));
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already recording/i);
    expect(screen.getByRole("button", { name: /start recording/i })).toBeEnabled();
  });

  it("falls back to idle and shows an error when stopRecording rejects", async () => {
    const { stopRecording } = await import("@/lib/recording");
    vi.mocked(stopRecording).mockRejectedValueOnce(new Error("no active recording"));
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no active recording/i);
    expect(screen.getByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });

  it("surfaces the quality warning returned by stopRecording", async () => {
    const { stopRecording } = await import("@/lib/recording");
    vi.mocked(stopRecording).mockResolvedValueOnce({
      output_path: "/tmp/audio.wav",
      quality_warning: "Audio level was very low",
    });
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    // The Processing pill is a small fixed-size window, so the warning is
    // surfaced as a compact icon with an accessible label/tooltip rather than
    // a full line of text -- see the qualityWarning rendering in
    // RecorderWidget's processing branch.
    expect(await screen.findByRole("img", { name: /audio level was very low/i })).toBeInTheDocument();
  });

  it("stays on idle and shows an error when createNewMeeting rejects", async () => {
    const { createNewMeeting } = await import("@/lib/storage");
    const { startRecording } = await import("@/lib/recording");
    vi.mocked(createNewMeeting).mockRejectedValueOnce(new Error("disk full"));
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/disk full/i);
    expect(startRecording).not.toHaveBeenCalled();
  });
});

describe("RecorderWidget meeting storage integration", () => {
  it("creates a meeting and builds the output path from the resolved data dir", async () => {
    const { startRecording } = await import("@/lib/recording");
    const { createNewMeeting } = await import("@/lib/storage");
    render(<RecorderWidget />);
    fireEvent.change(screen.getByPlaceholderText(/meeting title/i), {
      target: { value: "Team Sync" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await screen.findByRole("button", { name: /stop recording/i });
    expect(createNewMeeting).toHaveBeenCalledWith("Team Sync", "AutoDetect");
    expect(startRecording).toHaveBeenCalledWith(
      `/home/user/.local/share/meeting-notes/meetings/${fakeMeeting.id}/audio.wav`
    );
  });

  it("passes the meeting type chosen in the idle state to createNewMeeting", async () => {
    const { createNewMeeting } = await import("@/lib/storage");
    // The picker is a Radix Select, which ignores fireEvent — it opens on
    // pointer events and renders its options into a portal.
    const user = userEvent.setup();
    render(<RecorderWidget />);

    await user.click(screen.getByLabelText(/meeting type/i));
    await user.click(await screen.findByRole("option", { name: "Retrospective" }));
    await user.click(screen.getByRole("button", { name: /start recording/i }));

    await screen.findByRole("button", { name: /stop recording/i });
    expect(createNewMeeting).toHaveBeenCalledWith("", "Retrospective");
  });

  it("defaults the meeting type selector to Auto-detect", () => {
    render(<RecorderWidget />);
    expect(screen.getByLabelText(/meeting type/i)).toHaveTextContent("Auto-detect");
  });

  it("updates the meeting status to Transcribing after a successful stop", async () => {
    const { updateMeetingStatus } = await import("@/lib/storage");
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(updateMeetingStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: fakeMeeting.id, status: "Transcribing" })
      )
    );
  });

  it("marks the meeting Failed in the index when startRecording rejects after createNewMeeting resolves", async () => {
    const { startRecording } = await import("@/lib/recording");
    const { updateMeetingStatus } = await import("@/lib/storage");
    vi.mocked(startRecording).mockRejectedValueOnce(new Error("mic busy"));
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/mic busy/i);
    await vi.waitFor(() =>
      expect(updateMeetingStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: fakeMeeting.id, status: "Failed" })
      )
    );
  });

  it("persists the real used_system_audio value returned by startRecording", async () => {
    const { startRecording } = await import("@/lib/recording");
    const { updateMeetingStatus } = await import("@/lib/storage");
    vi.mocked(startRecording).mockResolvedValueOnce(true);
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(updateMeetingStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: fakeMeeting.id, used_system_audio: true })
      )
    );
  });

  it("still transitions to processing when updateMeetingStatus fails", async () => {
    const { updateMeetingStatus } = await import("@/lib/storage");
    vi.mocked(updateMeetingStatus).mockRejectedValueOnce(new Error("index write failed"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    expect(await screen.findByText(/transcribing/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    consoleErrorSpy.mockRestore();
  });
});

describe("RecorderWidget transcription integration", () => {
  it("calls transcribeMeeting with the resolved whisper model after entering processing", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: null,
      ollama_endpoint: null,
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "small.en",
      data_dir: null,
    });
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(transcribeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "small.en")
    );
  });

  // Regression test for a bug where handleStop sent the just-computed
  // {status: "Transcribing", duration_seconds} object to updateMeetingStatus
  // over IPC but never wrote it back into currentMeetingRef.current. Now that
  // transcribe_meeting only takes a meeting id (the Rust side re-fetches the
  // rest from the index rather than trusting a client-supplied MeetingMeta),
  // transcribeMeeting itself can no longer observe stale status/duration —
  // so this asserts the same fresh values against updateMeetingStatus
  // instead, the other call in this same code path that still takes the
  // full MeetingMeta and would previously have persisted a clobbered record
  // if currentMeetingRef were stale at the point it's called.
  it("passes the up-to-date status and duration to updateMeetingStatus, not the stale pre-stop meeting", async () => {
    const { updateMeetingStatus } = await import("@/lib/storage");
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(updateMeetingStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          id: fakeMeeting.id,
          status: "Transcribing",
          duration_seconds: expect.any(Number),
        })
      )
    );
    const [passedMeeting] = vi.mocked(updateMeetingStatus).mock.calls[0]!;
    expect(passedMeeting.status).not.toBe("Recording");
    expect(passedMeeting.duration_seconds).not.toBeNull();
  });

  it("falls back to base.en when whisper_model is not configured", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: null,
      ollama_endpoint: null,
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: null,
      data_dir: null,
    });
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(transcribeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "base.en")
    );
  });

  // The former "updates the current meeting ref and logs when
  // transcription-complete fires" test asserted the placeholder console.log
  // that stood in for summary generation. That log is now a real
  // summarizeMeeting call, and the ref update it checked is asserted
  // observably by "calls summarizeMeeting with the meeting id from the
  // transcription-complete event" below.

  it("surfaces a transcription error instead of hanging on Transcribing forever", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    vi.mocked(transcribeMeeting).mockRejectedValueOnce(new Error("whisper.cpp binary not found"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/whisper\.cpp binary not found/i);
    await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    consoleErrorSpy.mockRestore();
  });

  // Regression test for React.StrictMode (enabled app-wide in src/main.tsx)
  // double-invoking effects in dev: mount -> run -> cleanup -> run again.
  // The transcription effect must not let an abandoned first invocation
  // call transcribeMeeting (which spawns a real whisper.cpp subprocess) nor
  // leave its transcription-complete listener subscribed.
  it("only calls transcribeMeeting once and unsubscribes the abandoned listener under StrictMode's double-invoke", async () => {
    const { transcribeMeeting, onTranscriptionComplete } = await import("@/lib/transcription");
    const unlistenSpies: ReturnType<typeof vi.fn>[] = [];
    vi.mocked(onTranscriptionComplete).mockImplementation(async () => {
      const spy = vi.fn();
      unlistenSpies.push(spy);
      return spy;
    });

    render(
      <StrictMode>
        <RecorderWidget />
      </StrictMode>
    );
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    await vi.waitFor(() => expect(transcribeMeeting).toHaveBeenCalledTimes(1));
    // Only one listener registration should remain live; any abandoned
    // StrictMode invocation's listener must already be unsubscribed.
    const liveListeners = unlistenSpies.filter((spy) => spy.mock.calls.length === 0);
    expect(liveListeners).toHaveLength(1);
  });
});

describe("RecorderWidget summary integration", () => {
  // Registers the transcription-complete listener and hands back a trigger
  // so a test can fire the event at the exact moment it wants, rather than
  // racing the effect's async registration.
  async function captureTranscriptionCallback() {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });
    return {
      fire: async (meeting: MeetingMeta) => {
        await vi.waitFor(() => expect(fire).toBeDefined());
        await act(async () => {
          fire!(meeting);
        });
      },
    };
  }

  const transcribedMeeting: MeetingMeta = {
    ...fakeMeeting,
    status: "Summarizing",
    duration_seconds: 42,
  };

  it("switches the status to Generating summary once transcription completes", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    // Leave the summary call pending so the intermediate status is
    // observable instead of racing straight through to idle.
    vi.mocked(summarizeMeeting).mockImplementation(() => new Promise(() => {}));
    const { fire } = await captureTranscriptionCallback();

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    expect(await screen.findByText(/transcribing/i)).toBeInTheDocument();
    await fire(transcribedMeeting);
    expect(await screen.findByText(/generating summary/i)).toBeInTheDocument();
  });

  it("calls summarizeMeeting with the meeting id from the transcription-complete event", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const { fire } = await captureTranscriptionCallback();

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await fire(transcribedMeeting);

    await vi.waitFor(() => expect(summarizeMeeting).toHaveBeenCalledWith(transcribedMeeting.id));
  });

  it("leaves the processing state once the summary resolves", async () => {
    const { fire } = await captureTranscriptionCallback();

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await fire(transcribedMeeting);

    // Asserts both processing labels are gone, not just the summary one:
    // checking only "generating summary" would also pass while the widget
    // sat stuck on "Transcribing…".
    await vi.waitFor(() => {
      expect(screen.queryByText(/generating summary/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/transcribing/i)).not.toBeInTheDocument();
    });
  });

  it("opens summary.md externally and returns to idle once the summary resolves", async () => {
    const { openSummary } = await import("@/lib/storage");
    const { fire } = await captureTranscriptionCallback();

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await fire(transcribedMeeting);

    await vi.waitFor(() => expect(openSummary).toHaveBeenCalledWith(transcribedMeeting.id));
    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });

  // A failed summary must not wedge the widget in "Generating summary…"
  // forever: the transcript is already on disk, so the flow still returns
  // to idle rather than staying stuck.
  it("still leaves the processing state when the summary fails", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    vi.mocked(summarizeMeeting).mockRejectedValue(new Error("not_configured"));
    const { fire } = await captureTranscriptionCallback();

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await fire(transcribedMeeting);

    // Asserts both processing labels are gone, not just the summary one:
    // checking only "generating summary" would also pass while the widget
    // sat stuck on "Transcribing…".
    await vi.waitFor(() => {
      expect(screen.queryByText(/generating summary/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/transcribing/i)).not.toBeInTheDocument();
    });
  });
});

describe("RecorderWidget transcription failure recovery", () => {
  it("shows a retry option when transcription fails", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    vi.mocked(transcribeMeeting).mockRejectedValueOnce(
      new Error("whisper.cpp exited with status 1")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    expect(await screen.findByText(/transcription failed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it("re-runs transcription when Retry is clicked", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    vi.mocked(transcribeMeeting).mockRejectedValueOnce(new Error("whisper.cpp not found"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(transcribeMeeting).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await vi.waitFor(() => expect(transcribeMeeting).toHaveBeenCalledTimes(2));
    consoleErrorSpy.mockRestore();
  });

  it("clears the failure and returns to Transcribing while a retry is in flight", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    vi.mocked(transcribeMeeting).mockRejectedValueOnce(new Error("whisper.cpp not found"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    // The retry succeeds (the mock only rejects once), so the error must
    // clear rather than linger next to a live "Transcribing…" status.
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
    await vi.waitFor(() => {
      expect(screen.queryByText(/transcription failed/i)).not.toBeInTheDocument();
      expect(screen.getByText(/transcribing/i)).toBeInTheDocument();
    });
    consoleErrorSpy.mockRestore();
  });

  it("still reports the underlying error message alongside the retry option", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    vi.mocked(transcribeMeeting).mockRejectedValueOnce(
      new Error("whisper.cpp binary not found")
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/whisper\.cpp binary not found/i);
    consoleErrorSpy.mockRestore();
  });

  // Regression test: a persistently-failing transcription (bad config,
  // missing whisper model, corrupted audio) means Retry keeps failing
  // identically forever. Before this fix, the failed pill offered no way
  // out -- no Dismiss/Cancel affordance, and App.tsx's isPill gating hides
  // the entire TitleBar (Close/Settings/History) whenever state is
  // "processing", which a transcription failure never leaves. That left
  // the user stuck with only a Retry button that could never succeed.
  it("lets the user dismiss a failed transcription back to Idle", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    vi.mocked(transcribeMeeting).mockRejectedValue(new Error("whisper.cpp binary not found"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await screen.findByText(/transcription failed/i);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
    expect(screen.queryByText(/transcription failed/i)).not.toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});

describe("RecorderWidget summary failure fallback", () => {
  async function failSummaryWith(error: Error) {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    const { summarizeMeeting } = await import("@/lib/summary");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });
    vi.mocked(summarizeMeeting).mockRejectedValue(error);

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  // There is no in-app screen to surface a summarization failure on anymore
  // -- the transcript is still on disk, so the failure is logged and the
  // widget returns to idle rather than being stuck on "Generating summary…".
  it("logs the failure and returns to idle instead of opening a file", async () => {
    const { openSummary } = await import("@/lib/storage");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await failSummaryWith(new Error("not_configured"));

    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Summary generation failed:",
      expect.stringContaining("not_configured")
    );
    expect(openSummary).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("RecorderWidget resuming an interrupted recording", () => {
  const interrupted: MeetingMeta = {
    ...fakeMeeting,
    id: "2026-08-02_090000_standup",
    title: "Standup",
    status: "Recording",
  };

  it("jumps straight to processing when given a meeting to resume", async () => {
    render(<RecorderWidget resumeMeeting={interrupted} />);
    expect(await screen.findByText(/transcribing/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start recording/i })).not.toBeInTheDocument();
  });

  it("transcribes the resumed meeting, not a newly created one", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    const { createNewMeeting } = await import("@/lib/storage");

    render(<RecorderWidget resumeMeeting={interrupted} />);

    await vi.waitFor(() =>
      expect(transcribeMeeting).toHaveBeenCalledWith(interrupted.id, "base.en")
    );
    // Resuming reuses the existing meeting directory and its partial
    // audio.wav; creating a new meeting would orphan that recording.
    expect(createNewMeeting).not.toHaveBeenCalled();
  });

  it("starts in the idle state when there is nothing to resume", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    render(<RecorderWidget resumeMeeting={null} />);
    expect(screen.getByRole("button", { name: /start recording/i })).toBeInTheDocument();
    expect(transcribeMeeting).not.toHaveBeenCalled();
  });
});

describe("RecorderWidget provider picker", () => {
  it("persists a provider change without clearing the rest of the config", async () => {
    const { getConfig, saveConfig, setSummaryProvider } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: "gemma4:e2b",
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "small.en",
      data_dir: null,
    });

    render(<RecorderWidget />);
    fireEvent.click(await screen.findByRole("radio", { name: /claude/i }));

    // Uses the narrow set_summary_provider command, not saveConfig: getConfig()
    // returns environment values merged in, and round-tripping that whole
    // object through saveConfig would write an env-only API key to disk.
    await vi.waitFor(() => expect(setSummaryProvider).toHaveBeenCalledWith("claude"));
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe("RecorderWidget provider resolution at summarize time", () => {
  // Distinct from "RecorderWidget provider picker" above: that one sets a
  // persistent default (summary_provider) via the idle-state ProviderPicker.
  // This describes what actually runs once transcription finishes with more
  // than one provider configured — resolved the same way resolveProvider
  // resolves the Idle screen's highlighted choice, with no picker in between.
  async function completeTranscription() {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  it("summarizes immediately with Ollama when both providers are configured and no preference is persisted", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
      data_dir: null,
    });

    await completeTranscription();

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Ollama")
    );
    expect(screen.queryByRole("button", { name: /generate summary/i })).not.toBeInTheDocument();
  });

  it("summarizes immediately with the persisted preference when one is set", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: "claude",
      whisper_model: "base.en",
      data_dir: null,
    });

    await completeTranscription();

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Claude")
    );
  });

  it("opens the summary and returns to idle without any picker interaction", async () => {
    const { openSummary } = await import("@/lib/storage");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
      data_dir: null,
    });

    await completeTranscription();

    await vi.waitFor(() => expect(openSummary).toHaveBeenCalledWith(fakeMeeting.id));
    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });
});

describe("RecorderWidget single provider configured", () => {
  // Finding 2's fix touches the same branch that decides what gets passed
  // to summarizeMeeting when only one provider is configured — this path
  // changed in Task 2 from an implicit call to an explicit override and had
  // no dedicated coverage of its own.
  it("calls summarizeMeeting with the sole configured provider as an explicit override", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: null,
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
      data_dir: null,
    });
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });

    await vi.waitFor(() => expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Ollama"));
  });
});

describe("RecorderWidget long-run progress", () => {
  it("explains that summarizing takes a while instead of showing a bare label", async () => {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    const { summarizeMeeting } = await import("@/lib/summary");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });
    vi.mocked(summarizeMeeting).mockImplementation(() => new Promise(() => {}));

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });

    expect(await screen.findByText(/generating summary/i)).toBeInTheDocument();
    expect(screen.getByText(/may take a few minutes/i)).toBeInTheDocument();
  });
});
