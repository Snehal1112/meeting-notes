import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecorderWidget } from "./RecorderWidget";
import type { MeetingMeta } from "@/lib/storage";
import type { SummaryResult } from "@/lib/summary";
import type { AppConfig } from "@/lib/config";

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
  saveConfig: vi.fn(),
  setSummaryProvider: vi.fn(),
}));

vi.mock("@/lib/summary", async (importOriginal) => {
  // toProviderKind is pure ProviderName->ProviderKind mapping logic (no
  // Tauri invoke), so the real implementation is used here — only
  // summarizeMeeting (the actual IPC call) needs mocking.
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
      ollama_num_ctx: null,
      summary_provider: null,
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
  async function completeAFlowWith(summary: SummaryResult) {
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
      meeting_type: "Team sync",
      attendees: [],
      referenced_people: [],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [
        { text: "Send follow-up email", owner: null },
        { text: "Book the room", owner: null },
      ],
      open_questions: [],
    });

    expect(await screen.findByText(/discussed the q3 roadmap/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /action items/i }));
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
  });

  it("lists the attendees the model identified from the transcript", async () => {
    await completeAFlowWith({
      meeting_type: "Team sync",
      attendees: ["Parker", "Devi"],
      referenced_people: [],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
    });

    expect(await screen.findByText(/attendees mentioned: Parker, Devi/i)).toBeInTheDocument();
  });

  it("separates people who were only referenced from those on the call", async () => {
    await completeAFlowWith({
      meeting_type: "Team sync",
      attendees: ["Parker"],
      referenced_people: ["Craig"],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
    });

    const line = await screen.findByText(/attendees mentioned/i);
    expect(line).toHaveTextContent("Attendees mentioned: Parker");
    expect(line).toHaveTextContent("referenced but not confirmed on the call: Craig");
  });

  it("omits the attendee line entirely when no names were identified", async () => {
    // The transcript has no speaker labels, so an empty list is the honest
    // and common outcome. Rendering "Attendees: none" would read as a
    // finding rather than an absence.
    await completeAFlowWith({
      meeting_type: "Team sync",
      attendees: [],
      referenced_people: [],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
    });

    await screen.findByText(/discussed the q3 roadmap/i);
    expect(screen.queryByText(/attendees mentioned/i)).not.toBeInTheDocument();
  });

  it("checks an action item when its checkbox is clicked", async () => {
    await completeAFlowWith({
      meeting_type: "Team sync",
      attendees: [],
      referenced_people: [],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [{ text: "Send follow-up email", owner: null }],
      open_questions: [],
    });

    await userEvent.click(await screen.findByRole("tab", { name: /action items/i }));
    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await vi.waitFor(() => expect(checkbox).toBeChecked());
  });

  it("returns to idle when New Recording is clicked", async () => {
    await completeAFlowWith({
      meeting_type: "Team sync",
      attendees: [],
      referenced_people: [],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [],
      open_questions: [],
    });

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
      meeting_type: "Team sync",
      attendees: [],
      referenced_people: [],
      summary: "Discussed the Q3 roadmap.",
      topics: [],
      decisions: [],
      action_items: [{ text: "Send follow-up email", owner: null }],
      open_questions: [],
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

  it("tells the user to configure a provider when none is configured", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await failSummaryWith(new Error("not_configured"));

    expect(await screen.findByText(/configure a provider/i)).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  // A provider that is configured but broken (endpoint down, model not
  // pulled, bad key) is a different problem from having no provider at all,
  // and telling the user to "configure a provider" would be misleading.
  it("reports a generation failure distinctly from the not-configured case", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await failSummaryWith(new Error("Ollama returned status 500: model not found"));

    expect(await screen.findByText(/summary generation failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/configure a provider/i)).not.toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it("still shows the transcript tab when summary generation fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await failSummaryWith(new Error("not_configured"));

    await userEvent.click(await screen.findByRole("tab", { name: /transcript/i }));
    expect(await screen.findByText(/alice: let's ship on friday/i)).toBeInTheDocument();
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
      expect(transcribeMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ id: interrupted.id }),
        "base.en"
      )
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

const notes = (overrides: Partial<SummaryResult> = {}): SummaryResult => ({
  meeting_type: "Team sync",
  attendees: [],
  referenced_people: [],
  summary: "Discussed the Q3 roadmap.",
  topics: [],
  decisions: [],
  action_items: [],
  open_questions: [],
  ...overrides,
});

describe("RecorderWidget structured notes", () => {
  async function completeAFlowWithNotes(result: SummaryResult) {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    const { summarizeMeeting } = await import("@/lib/summary");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });
    vi.mocked(summarizeMeeting).mockResolvedValue(result);

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  it("renders topic headings and their points on the summary tab", async () => {
    await completeAFlowWithNotes(
      notes({ topics: [{ title: "Q3 OKRs", points: ["Events grew from 8 to 18."] }] })
    );
    expect(await screen.findByText("Q3 OKRs")).toBeInTheDocument();
    expect(screen.getByText(/events grew from 8 to 18/i)).toBeInTheDocument();
  });

  it("renders decisions and open questions on the summary tab", async () => {
    await completeAFlowWithNotes(
      notes({ decisions: ["Assignments stay self-managed."], open_questions: ["Who covers chat?"] })
    );
    expect(await screen.findByText(/assignments stay self-managed/i)).toBeInTheDocument();
    expect(screen.getByText(/who covers chat\?/i)).toBeInTheDocument();
  });

  it("omits the decisions heading when there are none", async () => {
    await completeAFlowWithNotes(notes({ decisions: [] }));
    await screen.findByText(/discussed the q3 roadmap/i);
    expect(screen.queryByText(/^decisions$/i)).not.toBeInTheDocument();
  });

  it("shows the owner next to an action item that has one", async () => {
    await completeAFlowWithNotes(
      notes({
        action_items: [
          { text: "Grab a booth slot", owner: "Parker" },
          { text: "Create a checklist", owner: null },
        ],
      })
    );
    await userEvent.click(await screen.findByRole("tab", { name: /action items/i }));
    expect(await screen.findByText(/parker/i)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  // Nothing in the Rust type prevents a topic with an empty points array —
  // the spec requires sections with no content to be omitted entirely, not
  // rendered as a bare heading with no list underneath.
  it("omits a topic's heading entirely when it has no points", async () => {
    await completeAFlowWithNotes(notes({ topics: [{ title: "Empty Topic", points: [] }] }));
    await screen.findByText(/discussed the q3 roadmap/i);
    expect(screen.queryByText("Empty Topic")).not.toBeInTheDocument();
  });

  // The Rust-side merge only dedupes across chunks, not within a single
  // model response, so a repeated bullet/decision/question inside one pass
  // is a real possibility. Content-derived keys (e.g. key={d}) would collide
  // on such a duplicate, causing React to warn and drop one of the two items.
  it("renders duplicate decisions within one list without a React key warning", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await completeAFlowWithNotes(
      notes({ decisions: ["Ship on Friday.", "Ship on Friday."] })
    );

    const matches = await screen.findAllByText(/ship on friday/i);
    expect(matches).toHaveLength(2);

    const keyWarning = consoleErrorSpy.mock.calls.some(([message]) =>
      typeof message === "string" && /unique.*"key"|same key/i.test(message)
    );
    expect(keyWarning).toBe(false);
    consoleErrorSpy.mockRestore();
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

describe("RecorderWidget manual provider selection at summarize time", () => {
  // Distinct from "RecorderWidget provider picker" above: that one sets a
  // persistent default (summary_provider) via the idle-state ProviderPicker.
  // This describes the ephemeral, per-run choice offered once transcription
  // finishes with more than one provider configured.
  async function reachChoosingProvider() {
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

  beforeEach(async () => {
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
    });
  });

  it("shows a picker instead of summarizing immediately when two providers are configured", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    await reachChoosingProvider();

    expect(await screen.findByRole("button", { name: /generate summary/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/summary provider/i)).toBeInTheDocument();
    expect(summarizeMeeting).not.toHaveBeenCalled();
  });

  it("calls summarizeMeeting with the selected provider once Generate Summary is clicked", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const user = userEvent.setup();
    await reachChoosingProvider();

    // Switch away from the default (Ollama — see the Ollama-preferring
    // default test below) before confirming — this is what the deferred
    // call is for: the selection made before confirming is the one that
    // actually runs.
    await user.click(screen.getByLabelText(/summary provider/i));
    await user.click(await screen.findByRole("option", { name: "Claude" }));
    await user.click(screen.getByRole("button", { name: /generate summary/i }));

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Claude")
    );
  });

  it("still reaches the done state with the summary after confirming", async () => {
    await reachChoosingProvider();
    await userEvent.click(screen.getByRole("button", { name: /generate summary/i }));

    expect(await screen.findByText(/discussed the roadmap/i)).toBeInTheDocument();
  });

  // Finding 2 of the whole-branch review: select_provider_kind on the Rust
  // side (crates/meeting-notes-summary/src/lib.rs) deliberately prefers
  // Ollama when both providers are configured and there's no persisted
  // preference. The picker's default must match, or a user who never set an
  // explicit preference gets Claude here while the rest of the app would
  // have picked Ollama for them.
  it("defaults the picker to Ollama when both providers are configured and no preference is persisted", async () => {
    await reachChoosingProvider();
    expect(await screen.findByLabelText(/summary provider/i)).toHaveTextContent("Ollama");
  });

  it("defaults the picker to the persisted provider preference when one is set", async () => {
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: "claude",
      whisper_model: "base.en",
    });
    await reachChoosingProvider();
    expect(await screen.findByLabelText(/summary provider/i)).toHaveTextContent("Claude");
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

describe("RecorderWidget regenerate with other provider", () => {
  // Distinct from "RecorderWidget manual provider selection at summarize
  // time" above: that describes the picker shown before the first summary.
  // This describes the Done-state action that re-runs summarization with
  // the alternate provider once a summary already exists.
  const bothProvidersConfig: AppConfig = {
    claude_api_key: "sk-test",
    ollama_endpoint: "http://localhost:11434",
    ollama_model: null,
    ollama_num_ctx: null,
    summary_provider: null,
    whisper_model: "base.en",
  };

  async function completeAFlowWithConfig(config: AppConfig) {
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue(config);
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

    // With two providers configured, summarization is deferred behind the
    // picker (see the describe block above) — confirm with the default
    // selection (Ollama-preferring, per Finding 2 of the review — see the
    // "defaults the picker to Ollama..." test above) so the widget actually
    // reaches the done state with a summary on screen.
    if (config.claude_api_key && config.ollama_endpoint) {
      await userEvent.click(await screen.findByRole("button", { name: /generate summary/i }));
    }
  }

  it("does not render a regenerate button when only one provider was configured", async () => {
    await completeAFlowWithConfig({
      claude_api_key: "sk-test",
      ollama_endpoint: null,
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
    });

    expect(await screen.findByText(/discussed the roadmap/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /regenerate with/i })).not.toBeInTheDocument();
  });

  it("shows a regenerate button offering the other provider when two were configured", async () => {
    await completeAFlowWithConfig(bothProvidersConfig);

    // The picker's default selection is Ollama (no persisted preference —
    // see Finding 2), so the regenerate button should offer Claude.
    expect(await screen.findByRole("button", { name: /regenerate with claude/i })).toBeInTheDocument();
  });

  it("calls summarizeMeeting with the alternate provider and updates the summary and action items", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    await completeAFlowWithConfig(bothProvidersConfig);

    vi.mocked(summarizeMeeting).mockResolvedValue({
      meeting_type: "Team sync",
      attendees: [],
      referenced_people: [],
      summary: "Regenerated with Claude.",
      topics: [],
      decisions: [],
      action_items: [{ text: "Follow up with design", owner: "Bob" }],
      open_questions: [],
    });

    await userEvent.click(await screen.findByRole("button", { name: /regenerate with claude/i }));

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenLastCalledWith(fakeMeeting.id, "Claude")
    );
    expect(await screen.findByText(/regenerated with claude/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /action items/i }));
    expect(await screen.findByText(/follow up with design/i)).toBeInTheDocument();
  });

  it("flips the button label to offer the other provider again after a successful regenerate", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    await completeAFlowWithConfig(bothProvidersConfig);

    await userEvent.click(await screen.findByRole("button", { name: /regenerate with claude/i }));

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenLastCalledWith(fakeMeeting.id, "Claude")
    );
    expect(await screen.findByRole("button", { name: /regenerate with ollama/i })).toBeInTheDocument();
  });

  it("disables the button and shows a regenerating label while the call is in flight", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    await completeAFlowWithConfig(bothProvidersConfig);
    vi.mocked(summarizeMeeting).mockImplementation(() => new Promise(() => {}));

    await userEvent.click(await screen.findByRole("button", { name: /regenerate with claude/i }));

    const button = await screen.findByRole("button", { name: /regenerating/i });
    expect(button).toBeDisabled();
  });

  // Finding 3 of the whole-branch review: a regenerate failure must not
  // erase a summary the user already had, and Finding 1's cancellation
  // guard must not interfere with the intentional "flip the provider so an
  // immediate retry targets the other one" behavior on a genuine failure
  // (as opposed to an abandoned run, which the guard suppresses entirely).
  it("keeps the existing summary and flips the button label when a regenerate call fails", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    await completeAFlowWithConfig(bothProvidersConfig);
    const regenerateButton = await screen.findByRole("button", { name: /regenerate with claude/i });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(summarizeMeeting).mockRejectedValueOnce(new Error("Claude request failed: 401"));
    await userEvent.click(regenerateButton);

    // The already-loaded summary must still be on screen, with the failure
    // surfaced alongside it rather than in its place.
    await vi.waitFor(() =>
      expect(screen.getByText(/summary generation failed/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/discussed the roadmap/i)).toBeInTheDocument();

    // selectedProvider still flips to the attempted target (Claude) despite
    // the failure, so the button now offers an immediate retry of Ollama.
    expect(await screen.findByRole("button", { name: /regenerate with ollama/i })).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
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
