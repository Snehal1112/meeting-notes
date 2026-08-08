import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startRecording, stopRecording } from "@/lib/recording";
import { MeetingTypePicker } from "@/components/MeetingTypePicker";
import {
  createNewMeeting,
  getDataDir,
  openSummary,
  updateMeetingStatus,
  type MeetingMeta,
  type MeetingType,
} from "@/lib/storage";
import { transcribeMeeting, onTranscriptionComplete } from "@/lib/transcription";
import { getConfig, setSummaryProvider, type AppConfig } from "@/lib/config";
import {
  summarizeMeeting,
  resolveProvider,
  onSummaryProgress,
  type ProviderKind,
  type SummaryPass,
} from "@/lib/summary";
import { SummaryChecklist } from "@/components/SummaryChecklist";
import { Waveform } from "@/components/Waveform";
import { ProviderPicker, type ProviderName } from "@/components/ProviderPicker";
import { startWindowDrag } from "@/lib/drag";
import { Mic, MicOff, Square, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export type WidgetState = "idle" | "recording" | "processing";
type ProcessingStatus = "transcribing" | "summarizing";

interface RecorderWidgetProps {
  /// An interrupted recording from a previous session to pick up, as offered
  /// by the launch-time ResumePrompt. Null when there is nothing to resume.
  resumeMeeting?: MeetingMeta | null;
  /// Notifies the caller (App.tsx) whenever the widget's own state changes,
  /// so window-level decisions that live outside this component -- chrome
  /// visibility, window size -- can react to it. Optional so existing
  /// standalone usage (e.g. tests rendering RecorderWidget on its own) keeps
  /// working unchanged.
  onStateChange?: (state: WidgetState) => void;
  /// A counter bumped by the caller (App.tsx) each time the system tray's
  /// "New Recording" menu item is clicked. A counter rather than a boolean
  /// so two clicks in a row -- both while still idle -- each register as a
  /// distinct change even though the value in between never resets.
  triggerNewRecording?: number;
}

export function RecorderWidget({
  resumeMeeting = null,
  onStateChange,
  triggerNewRecording,
}: RecorderWidgetProps = {}) {
  const [state, setState] = useState<WidgetState>("idle");
  const [title, setTitle] = useState("");
  const [meetingType, setMeetingType] = useState<MeetingType>("AutoDetect");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [micOnlyWarning, setMicOnlyWarning] = useState(false);
  const [qualityWarning, setQualityWarning] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>("transcribing");
  const [summaryStep, setSummaryStep] = useState<SummaryPass | "complete" | null>(null);
  const [summaryChunk, setSummaryChunk] = useState<{ index: number; total: number }>({ index: 0, total: 1 });
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const currentMeetingRef = useRef<MeetingMeta | null>(null);
  // Guards runSummarization against a stale run clobbering state the widget
  // has already moved on to (e.g. a new recording started while a previous
  // meeting's summarization was still in flight). Bumped wherever the widget
  // leaves the state that a run belongs to; runSummarization checks it
  // before every set* call so an abandoned run's result or error never
  // lands after the fact.
  const summarizeRunRef = useRef(0);
  // Mirrors summaryStep but readable synchronously inside runSummarization's
  // catch block without adding summaryStep to that callback's dependency
  // array (which would otherwise recreate it on every progress event).
  const summaryStepRef = useRef<SummaryPass | "complete" | null>(null);
  // Guards runTranscription against a real double-click: both native click
  // events can dispatch before React re-renders the Retry button away, so
  // the guard has to live outside render rather than relying on the button
  // disappearing in time.
  const transcriptionInFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Wall-clock start time, so the elapsed timer cannot drift when ticks are throttled.
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) => console.error("Could not load config:", errorMessage(err)));
  }, []);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  useEffect(() => {
    if (state === "recording") {
      timerRef.current = setInterval(
        () => setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)),
        1000
      );
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state]);

  // Kick off transcription as soon as we enter the processing state. The
  // recording itself is already safely on disk by this point, so a
  // transcription failure here must not look like data loss — it's surfaced
  // via transcriptionError instead of leaving the widget stuck silently.
  //
  // Picking up an interrupted recording skips straight to processing: its
  // partial audio.wav is already on disk, so the only work left is
  // transcription onwards. The ref must be assigned before the state change
  // so the processing effect below sees the meeting on its first run.
  useEffect(() => {
    if (!resumeMeeting) return;
    currentMeetingRef.current = resumeMeeting;
    setState("processing");
  }, [resumeMeeting]);

  // Kicks off whisper.cpp for the current meeting. Shared by the processing
  // effect below and the Retry button, so a retry re-runs the exact same
  // path. `isCancelled` lets the effect abandon its own invocation without
  // the retry path needing any cancellation concept — a retry is always
  // live, since the user just clicked it.
  const runTranscription = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (transcriptionInFlightRef.current) return;
    transcriptionInFlightRef.current = true;
    setTranscriptionError(null);
    setProcessingStatus("transcribing");
    try {
      const config = await getConfig();
      if (isCancelled()) return;
      await transcribeMeeting(currentMeetingRef.current!.id, config.whisper_model ?? "base.en");
    } catch (err) {
      if (isCancelled()) return;
      console.error("Transcription failed:", errorMessage(err));
      setTranscriptionError(errorMessage(err));
    } finally {
      transcriptionInFlightRef.current = false;
    }
  }, []);

  // Retry re-runs the exact same transcription and can fail identically
  // forever when the cause isn't transient (bad config, missing whisper
  // model, corrupted audio) -- Dismiss is the escape hatch for that case.
  // The meeting was already marked Failed and persisted by the backend
  // when transcriptionError was first set, so nothing is lost: it stays
  // reachable (and retryable) from History. This only resets local
  // widget state, back to the same Idle the app starts in.
  const handleDismissFailure = () => {
    currentMeetingRef.current = null;
    setTranscriptionError(null);
    setState("idle");
  };

  // Actually calls summarize_meeting, opens the generated summary.md in the
  // system's default handler, and returns the widget to idle. Split out
  // from the processing effect below purely for readability.
  const runSummarization = useCallback(async (meetingId: string, provider?: ProviderKind) => {
    // Claim this as the current run. If summarizeRunRef.current no longer
    // matches `run` by the time an awaited call below resolves, the widget
    // has since left the state this run belongs to (e.g. a new recording
    // started) — every set* call, including in `finally`, must then be
    // skipped so a late-arriving run cannot yank the UI back.
    const run = ++summarizeRunRef.current;
    setProcessingStatus("summarizing");
    setSummaryStep(null);
    summaryStepRef.current = null;
    setSummaryChunk({ index: 0, total: 1 });
    setSummaryFailed(false);

    let unlistenProgress: (() => void) | undefined;
    try {
      unlistenProgress = await onSummaryProgress((progress) => {
        if (summarizeRunRef.current !== run) return;
        setSummaryStep(progress.pass);
        summaryStepRef.current = progress.pass;
        setSummaryChunk({ index: progress.chunk_index, total: progress.chunk_total });
      });
      if (summarizeRunRef.current !== run) return;

      // Called with only one argument (no explicit `undefined` forwarded)
      // when there is nothing to override, so the zero-provider path is
      // observably identical to the pre-picker call site.
      provider ? await summarizeMeeting(meetingId, provider) : await summarizeMeeting(meetingId);
      if (summarizeRunRef.current !== run) return;
      setSummaryStep("complete");
      summaryStepRef.current = "complete";
      try {
        await openSummary(meetingId);
      } catch (err) {
        // Opening externally failing shouldn't strand the user on a stuck
        // Processing pill — the file is still on disk even if it couldn't
        // be opened for them.
        console.error("Failed to open summary.md externally:", errorMessage(err));
      }
    } catch (err) {
      if (summarizeRunRef.current !== run) return;
      // The transcript is already on disk, so a summary failure is not data
      // loss. The toast is what tells the user it happened either way; if
      // the checklist ever showed a step in progress, briefly mark it
      // errored before returning to idle instead of yanking the pill away
      // the instant the toast fires, so the user sees which step failed
      // rather than the checklist just vanishing mid-step.
      console.error("Summary generation failed:", errorMessage(err));
      toast.error(`Failed to generate summary: ${errorMessage(err)}`);
      if (summaryStepRef.current !== null && summaryStepRef.current !== "complete") {
        setSummaryFailed(true);
        unlistenProgress?.();
        unlistenProgress = undefined;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      unlistenProgress?.();
      if (summarizeRunRef.current === run) setState("idle");
    }
  }, []);

  // React.StrictMode (see src/main.tsx) double-invokes effects in dev:
  // mount -> run -> cleanup -> run again. Without the `cancelled` checks
  // below, that would fire two concurrent real whisper.cpp subprocesses (via
  // transcribeMeeting) for the same meeting, plus leak the first run's event
  // listener if its cleanup ran before `onTranscriptionComplete` resolved.
  // Every async gap re-checks `cancelled` so an abandoned first invocation
  // never calls transcribeMeeting and never leaves a live listener behind.
  useEffect(() => {
    if (state !== "processing" || !currentMeetingRef.current) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    setProcessingStatus("transcribing");
    (async () => {
      const stopListening = await onTranscriptionComplete(async (updated) => {
        // An abandoned invocation's listener may still receive one event
        // before its unsubscribe lands, so re-check here too: only the live
        // invocation may drive the summary and the state transition.
        if (cancelled) return;
        currentMeetingRef.current = updated;
        setProcessingStatus("summarizing");
        // Reset the checklist's visible state right here, not just later
        // inside runSummarization. processingStatus flips to "summarizing"
        // (and SummaryChecklist starts rendering) before the getConfig()
        // await below and before runSummarization is even called, so without
        // this the checklist would render for one real IPC round trip using
        // stale summaryStep/summaryChunk/summaryFailed left over from a
        // PREVIOUS meeting's run -- e.g. briefly flashing a red error icon on
        // a step that hasn't started yet for this meeting.
        setSummaryStep(null);
        summaryStepRef.current = null;
        setSummaryChunk({ index: 0, total: 1 });
        setSummaryFailed(false);

        // Determine which providers are actually usable for this run. Fetched
        // fresh here (rather than reusing the mount-time `config` state)
        // since that's what actually gates the summarize_meeting call below.
        const cfg = await getConfig().catch((err) => {
          console.error("Could not load config for provider selection:", errorMessage(err));
          return null;
        });
        if (cancelled) return;

        // The provider was already effectively chosen on the Idle screen —
        // ProviderPicker shows the same resolution as selected before the
        // recording even started — so summarization starts immediately
        // rather than asking again here. undefined (nothing configured)
        // reaches summarizeMeeting as no explicit override, letting the
        // "not_configured" error path fire as usual.
        await runSummarization(updated.id, resolveProvider(cfg));
      });
      unlisten = stopListening;
      if (cancelled) {
        // Cleanup already ran before this listener finished registering —
        // this invocation was abandoned (e.g. StrictMode's discarded first
        // run). Unsubscribe immediately and never call transcribeMeeting.
        stopListening();
        return;
      }

      await runTranscription(() => cancelled);
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [state]);

  // Uses the narrow set_summary_provider command rather than saveConfig:
  // config here can include values that only ever came from the environment
  // (getConfig() returns the resolved config), and round-tripping those
  // through saveConfig would write them into the plaintext config file.
  const handleProviderChange = async (provider: ProviderName) => {
    if (!config) return;
    setConfig({ ...config, summary_provider: provider });
    try {
      await setSummaryProvider(provider);
    } catch (err) {
      console.error("Could not save the provider choice:", errorMessage(err));
    }
  };

  const handleStart = async () => {
    if (busy) return;
    setBusy(true);
    setRecordingError(null);
    setElapsedSeconds(0);
    setQualityWarning(null);
    setTranscriptionError(null);
    // Invalidate any summarization still in flight for the previous meeting
    // — see summarizeRunRef above. Without this, a stale run resolving after
    // this new recording starts would open the old meeting's summary.md.
    summarizeRunRef.current++;
    try {
      const meeting = await createNewMeeting(title, meetingType);
      currentMeetingRef.current = meeting;
      const outputPath = `${await meetingsDataDir()}/meetings/${meeting.id}/audio.wav`;
      const usedSystemAudio = await startRecording(outputPath);
      currentMeetingRef.current = { ...currentMeetingRef.current, used_system_audio: usedSystemAudio };
      setMicOnlyWarning(!usedSystemAudio);
      startedAtRef.current = Date.now();
      setState("recording");
    } catch (err) {
      // If the meeting entry was already committed to the index but recording
      // never actually started, mark it Failed so it isn't mistaken for a
      // crashed/interrupted session by orphan detection. Best-effort: don't
      // let a failure here mask the original error.
      if (currentMeetingRef.current) {
        updateMeetingStatus(currentMeetingRef.current.id, "Failed").catch((e) =>
          console.error("Failed to mark meeting failed:", errorMessage(e))
        );
        currentMeetingRef.current = null;
      }
      setRecordingError(`Could not start recording: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (busy) return;
    setBusy(true);
    setRecordingError(null);
    setTranscriptionError(null);
    try {
      const result = await stopRecording();
      setQualityWarning(result.quality_warning);
      setState("processing");

      // The audio is already safely on disk at this point, so a failure to
      // update the meeting index shouldn't block the UI transition or be
      // reported as a recording error — just log it so it isn't silently lost.
      if (currentMeetingRef.current) {
        const transcribing: MeetingMeta = {
          ...currentMeetingRef.current,
          status: "Transcribing",
          duration_seconds: elapsedSeconds,
        };
        // Update the in-memory ref immediately — before the persist even
        // starts, not after it resolves. The transcription effect above is
        // scheduled by the setState("processing") call right above this
        // block and may read this ref before updateMeetingStatus's IPC call
        // resolves; the ref represents intent and must not depend on the
        // persist succeeding or winning a timing race. If the IPC call below
        // fails, the ref still holds these correct values, and the later
        // transcribe_meeting Rust call's full-record replace will simply
        // re-persist them.
        currentMeetingRef.current = transcribing;
        try {
          await updateMeetingStatus(
            transcribing.id,
            "Transcribing",
            elapsedSeconds,
            transcribing.used_system_audio
          );
        } catch (err) {
          console.error("Failed to update meeting status in index:", errorMessage(err));
        }
      }
    } catch (err) {
      // The backend already dropped its recording state before failing, so
      // staying on the recording screen would wedge the widget. Go back to idle.
      setRecordingError(`Could not stop recording: ${errorMessage(err)}`);
      setState("idle");
    } finally {
      setBusy(false);
    }
  };

  // Fires handleStart when the system tray's "New Recording" menu item is
  // clicked while the widget is idle. Mirrors the resumeMeeting effect
  // above's shape, but resumeMeeting can rely on a plain null check because
  // "nothing to resume" is itself falsy -- triggerNewRecording is a counter
  // whose legitimate starting value (0, or unset) is not distinguishable
  // from "no change" that way, so a ref holding the last-seen value is used
  // instead: only an actual change away from it fires handleStart, so this
  // never fires on mount or on an unrelated re-render (e.g. entering or
  // leaving processing) where the counter itself hasn't moved.
  const prevTriggerNewRecordingRef = useRef(triggerNewRecording);
  useEffect(() => {
    if (triggerNewRecording === undefined) return;
    if (prevTriggerNewRecordingRef.current === triggerNewRecording) return;
    prevTriggerNewRecordingRef.current = triggerNewRecording;
    if (state === "idle") {
      handleStart();
    }
    // A recording already in progress (or processing) is deliberately a
    // no-op here rather than queued -- the tray click is simply ignored,
    // same as clicking "Start Recording" again mid-recording would be.
  }, [triggerNewRecording, state]);

  const formattedTime = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(
    elapsedSeconds % 60
  ).padStart(2, "0")}`;

  const errorNotice = recordingError && (
    <span role="alert" className="text-xs text-red-600">
      {recordingError}
    </span>
  );

  if (state === "idle") {
    return (
      <div className="flex flex-col gap-3 h-full justify-center">
        {errorNotice}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            New meeting
          </span>
          <Input
            placeholder="Meeting title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="border-none shadow-none px-0 py-0 h-auto text-lg font-medium placeholder:text-muted-foreground/50 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
        <MeetingTypePicker value={meetingType} onChange={setMeetingType} disabled={busy} />
        <ProviderPicker config={config} onChange={handleProviderChange} />
        <Button onClick={handleStart} disabled={busy} className="h-11 gap-2 mt-1">
          <Mic className="h-4 w-4" />
          Start Recording
        </Button>
      </div>
    );
  }

  if (state === "recording") {
    // recordingError is intentionally not rendered here: it is only ever set
    // by handleStart's catch (which never transitions into this state) or
    // handleStop's catch (which transitions to "idle", not "recording"), so
    // it can never actually be non-null while state === "recording" -- it
    // stays in the Idle branch, where it's real. micOnlyWarning, by
    // contrast, genuinely can be true here (handleStart sets it right before
    // this transition), so it still needs to be surfaced -- just compactly,
    // since this pill is a small fixed-size window (224x56).
    return (
      <div
        data-tauri-drag-region
        // There is no title bar in the pill states, so the pill itself is the
        // only drag surface -- and data-tauri-drag-region alone is unreliable
        // under WebKitGTK, this project's primary platform. requireSelfTarget
        // keeps the fallback from swallowing presses on the Stop button.
        onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
        className="h-full w-full flex items-center justify-center gap-2.5 bg-background border rounded-full pl-3.5 pr-2 py-2 shadow-sm"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse flex-shrink-0" />
        {micOnlyWarning && (
          <span
            role="img"
            aria-label="System audio unavailable — recording mic only"
            title="System audio unavailable — recording mic only"
            className="flex-shrink-0 text-amber-600"
          >
            <MicOff className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
        <span className="text-xs font-mono text-foreground tabular-nums flex-shrink-0">
          {formattedTime}
        </span>
        <Waveform active={state === "recording"} compact />
        <Button
          variant="destructive"
          size="icon"
          onClick={handleStop}
          disabled={busy}
          aria-label="Stop Recording"
          className="h-7 w-7 rounded-full flex-shrink-0 bg-destructive text-white hover:bg-destructive/90"
        >
          <Square className="h-2.5 w-2.5 fill-current" />
        </Button>
      </div>
    );
  }

  if (state === "processing") {
    return (
      <div
        data-tauri-drag-region
        // Same reasoning as the Recording pill above. requireSelfTarget
        // matters more here: this pill can hold a Retry button, which would
        // otherwise have its mousedown turned into a window drag on the way up.
        onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
        className="h-full w-full flex items-center justify-center gap-2 bg-background border rounded-2xl px-4 py-3 shadow-sm text-sm text-muted-foreground"
      >
        {qualityWarning && (
          // Fixed-size card (340x220), so an arbitrary-length backend string
          // gets a compact icon + tooltip/accessible-label instead of a full
          // line, the same treatment as micOnlyWarning in the Recording pill.
          <span
            role="img"
            aria-label={qualityWarning}
            title={qualityWarning}
            className="flex-shrink-0 text-amber-600"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
        {transcriptionError ? (
          // The audio is always preserved on disk, so this is recoverable:
          // offer the retry rather than sending the user back to idle. The
          // underlying error sits alongside it so a missing binary or bad
          // model name is diagnosable, not just "it failed".
          <div role="alert" className="flex items-center gap-1.5 min-w-0">
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[10px] font-medium text-red-600">Transcription failed</span>
              <span className="text-[9px] text-muted-foreground truncate max-w-[130px]">
                {transcriptionError}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => runTranscription()}
              className="flex-shrink-0"
            >
              Retry
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleDismissFailure}
              className="flex-shrink-0"
            >
              Dismiss
            </Button>
          </div>
        ) : processingStatus === "summarizing" ? (
          <SummaryChecklist
            currentStep={summaryStep}
            failed={summaryFailed}
            chunkIndex={summaryChunk.index}
            chunkTotal={summaryChunk.total}
          />
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex-shrink-0" />
            <span className="text-xs truncate">Transcribing…</span>
          </div>
        )}
      </div>
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function meetingsDataDir(): Promise<string> {
  return getDataDir();
}
