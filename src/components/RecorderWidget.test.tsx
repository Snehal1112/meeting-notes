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
}));

vi.mock("@/lib/transcription", () => ({
  transcribeMeeting: vi.fn(),
  readTranscriptText: vi.fn(),
  onTranscriptionComplete: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(),
}));

vi.mock("@/lib/summary", () => ({
  summarizeMeeting: vi.fn(),
}));

const fakeMeeting = {
  id: "2026-08-02_120000_test-meeting",
  title: "Test meeting",
  created_at: "2026-08-02T12:00:00Z",
  duration_seconds: null,
  status: "Recording" as const,
  used_system_audio: false,
};

beforeEach(async () => {
  const { startRecording, stopRecording } = await import("@/lib/recording");
  vi.mocked(startRecording).mockReset().mockResolvedValue(true);
  vi.mocked(stopRecording)
    .mockReset()
    .mockResolvedValue({ output_path: "/tmp/audio.wav", quality_warning: null });

  const { createNewMeeting, updateMeetingStatus, getDataDir } = await import("@/lib/storage");
  vi.mocked(createNewMeeting).mockReset().mockResolvedValue(fakeMeeting);
  vi.mocked(updateMeetingStatus).mockReset().mockResolvedValue(undefined);
  vi.mocked(getDataDir).mockReset().mockResolvedValue("/home/user/.local/share/meeting-notes");

  const { transcribeMeeting, readTranscriptText, onTranscriptionComplete } = await import(
    "@/lib/transcription"
  );
  vi.mocked(transcribeMeeting).mockReset().mockResolvedValue(undefined);
  vi.mocked(readTranscriptText).mockReset().mockResolvedValue("Alice: Let's ship on Friday.");
  vi.mocked(onTranscriptionComplete).mockReset().mockResolvedValue(() => {});

  const { summarizeMeeting } = await import("@/lib/summary");
  vi.mocked(summarizeMeeting)
    .mockReset()
    .mockResolvedValue({ summary: "Discussed the roadmap.", action_items: [] });

  const { getConfig } = await import("@/lib/config");
  vi.mocked(getConfig).mockReset().mockResolvedValue({
    claude_api_key: null,
    ollama_endpoint: null,
    ollama_model: null,
    whisper_model: "base.en",
  });
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
    expect(await screen.findByText(/audio level was very low/i)).toBeInTheDocument();
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
    expect(createNewMeeting).toHaveBeenCalledWith("Team Sync");
    expect(startRecording).toHaveBeenCalledWith(
      `/home/user/.local/share/meeting-notes/meetings/${fakeMeeting.id}/audio.wav`
    );
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
      whisper_model: "small.en",
    });
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(transcribeMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ id: fakeMeeting.id }),
        "small.en"
      )
    );
  });

  // Regression test for a bug where handleStop sent the just-computed
  // {status: "Transcribing", duration_seconds} object to updateMeetingStatus
  // over IPC but never wrote it back into currentMeetingRef.current. The
  // transcription effect then read the same stale ref (still
  // status: "Recording", duration_seconds: null from meeting creation) and
  // handed it to transcribeMeeting, whose Rust side does a full-record index
  // replace — silently reverting the update that updateMeetingStatus had
  // just persisted. Asserting only `id` (as the tests above do) doesn't
  // catch this; the fields that actually got clobbered must be asserted.
  it("passes the up-to-date status and duration to transcribeMeeting, not the stale pre-stop meeting", async () => {
    const { transcribeMeeting } = await import("@/lib/transcription");
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(transcribeMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          id: fakeMeeting.id,
          status: "Transcribing",
          duration_seconds: expect.any(Number),
        }),
        expect.any(String)
      )
    );
    const [passedMeeting] = vi.mocked(transcribeMeeting).mock.calls[0]!;
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
      whisper_model: null,
    });
    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() =>
      expect(transcribeMeeting).toHaveBeenCalledWith(expect.objectContaining({ id: fakeMeeting.id }), "base.en")
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
    // observable instead of racing straight through to the done state.
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

  // A failed summary must not wedge the widget in "Generating summary…"
  // forever: the transcript is already on disk and is still worth showing,
  // so the flow always resolves to the done state.
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

describe("RecorderWidget done state", () => {
  async function completeAFlowWith(summary: {
    summary: string;
    action_items: string[];
  }) {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    const { summarizeMeeting } = await import("@/lib/summary");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });
    vi.mocked(summarizeMeeting).mockResolvedValue(summary);

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  it("shows the summary text and one checkbox per action item", async () => {
    await completeAFlowWith({
      summary: "Discussed the Q3 roadmap.",
      action_items: ["Send follow-up email", "Book the room"],
    });

    expect(await screen.findByText(/discussed the q3 roadmap/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /action items/i }));
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
  });

  it("checks an action item when its checkbox is clicked", async () => {
    await completeAFlowWith({
      summary: "Discussed the Q3 roadmap.",
      action_items: ["Send follow-up email"],
    });

    await userEvent.click(await screen.findByRole("tab", { name: /action items/i }));
    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await vi.waitFor(() => expect(checkbox).toBeChecked());
  });

  it("returns to idle when New Recording is clicked", async () => {
    await completeAFlowWith({ summary: "Discussed the Q3 roadmap.", action_items: [] });

    fireEvent.click(await screen.findByRole("button", { name: /new recording/i }));
    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });
});

describe("RecorderWidget done state tabs", () => {
  async function completeAFlow() {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    const { summarizeMeeting } = await import("@/lib/summary");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });
    vi.mocked(summarizeMeeting).mockResolvedValue({
      summary: "Discussed the Q3 roadmap.",
      action_items: ["Send follow-up email"],
    });

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  it("shows the summary tab first", async () => {
    await completeAFlow();
    expect(await screen.findByRole("tab", { name: /summary/i })).toBeInTheDocument();
    expect(await screen.findByText(/discussed the q3 roadmap/i)).toBeInTheDocument();
  });

  it("shows the action items checklist on the Action Items tab", async () => {
    await completeAFlow();
    await userEvent.click(await screen.findByRole("tab", { name: /action items/i }));
    expect(await screen.findByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByText(/send follow-up email/i)).toBeInTheDocument();
  });

  it("shows the fetched transcript text on the Transcript tab", async () => {
    await completeAFlow();
    await userEvent.click(await screen.findByRole("tab", { name: /transcript/i }));
    expect(await screen.findByText(/alice: let's ship on friday/i)).toBeInTheDocument();
  });

  it("fetches the transcript for the meeting from the transcription-complete event", async () => {
    const { readTranscriptText } = await import("@/lib/transcription");
    await completeAFlow();
    await vi.waitFor(() => expect(readTranscriptText).toHaveBeenCalledWith(fakeMeeting.id));
  });

  // A missing or unreadable transcript.txt must not blank the tab with no
  // explanation, and must not stop the summary from being shown.
  it("falls back to a placeholder when the transcript cannot be read", async () => {
    const { readTranscriptText } = await import("@/lib/transcription");
    vi.mocked(readTranscriptText).mockRejectedValue(new Error("could not read transcript"));
    await completeAFlow();
    await userEvent.click(await screen.findByRole("tab", { name: /transcript/i }));
    expect(await screen.findByText(/transcript unavailable/i)).toBeInTheDocument();
  });

  it("returns to idle when Save & Close is clicked", async () => {
    await completeAFlow();
    fireEvent.click(await screen.findByRole("button", { name: /save & close/i }));
    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
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
});
