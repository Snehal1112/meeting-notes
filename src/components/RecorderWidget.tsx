import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { startRecording, stopRecording } from "@/lib/recording";
import { MeetingTypePicker, MEETING_TYPES } from "@/components/MeetingTypePicker";
import {
  createNewMeeting,
  getDataDir,
  updateMeetingStatus,
  type MeetingMeta,
  type MeetingType,
} from "@/lib/storage";
import { transcribeMeeting, readTranscriptText, onTranscriptionComplete } from "@/lib/transcription";
import { getConfig, setSummaryProvider, type AppConfig } from "@/lib/config";
import { summarizeMeeting, toProviderKind, type SummaryResult, type ProviderKind } from "@/lib/summary";
import { Waveform } from "@/components/Waveform";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ProviderPicker, type ProviderName } from "@/components/ProviderPicker";
import { startWindowDrag } from "@/lib/drag";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Mic, MicOff, Square, AlertTriangle } from "lucide-react";

// Action items are stored flat (no per-item ids), see runSummarization below
// -- the checklist keys off array position instead.
export interface ActionItem {
  id: string;
  text: string;
  owner: string | null;
  completed: boolean;
}

export type WidgetState = "idle" | "recording" | "processing" | "done";
// "choosing_provider" is a distinct sub-status from "summarizing": it's the
// window between transcription finishing and the user confirming which
// provider to use for this run, shown only when more than one provider is
// configured. "summarizing" still means "the call is actually in flight".
type ProcessingStatus = "transcribing" | "choosing_provider" | "summarizing";

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
}

export function RecorderWidget({ resumeMeeting = null, onStateChange }: RecorderWidgetProps = {}) {
  const [state, setState] = useState<WidgetState>("idle");
  const [title, setTitle] = useState("");
  const [meetingType, setMeetingType] = useState<MeetingType>("AutoDetect");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [micOnlyWarning, setMicOnlyWarning] = useState(false);
  const [qualityWarning, setQualityWarning] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>("transcribing");
  const [summaryResult, setSummaryResult] = useState<SummaryResult | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [transcriptText, setTranscriptText] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  // Ephemeral, per-run provider choice for the summary about to be
  // generated — distinct from ProviderPicker/handleProviderChange above,
  // which set a persistent default saved to config. These are only
  // populated (and only shown) when transcription just finished with more
  // than one provider configured; they are not persisted anywhere.
  const [availableProviders, setAvailableProviders] = useState<ProviderKind[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind | null>(null);
  // Drives only the Done-state "Regenerate with [other provider]" button's
  // disabled/label state while a regenerate run is in flight.
  const [isRegenerating, setIsRegenerating] = useState(false);
  const currentMeetingRef = useRef<MeetingMeta | null>(null);
  // Guards runSummarization against a stale run clobbering state the widget
  // has already moved on to. Unlike runTranscription (only ever invoked from
  // the processing effect, which offers no way to leave that state),
  // runSummarization is also invoked from the Done-state regenerate button —
  // and Done leaves New Recording and Save & Close enabled while a regenerate
  // is in flight. Bumped wherever the widget leaves the state that a
  // regenerate run belongs to; runSummarization checks it before every
  // set* call so an abandoned run's result or error never lands after the
  // fact. See runSummarization below for the actual guard.
  const summarizeRunRef = useRef(0);
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
    setTranscriptionError(null);
    setProcessingStatus("transcribing");
    try {
      const config = await getConfig();
      if (isCancelled()) return;
      await transcribeMeeting(currentMeetingRef.current!, config.whisper_model ?? "base.en");
    } catch (err) {
      if (isCancelled()) return;
      console.error("Transcription failed:", errorMessage(err));
      setTranscriptionError(errorMessage(err));
    }
  }, []);

  // Actually calls summarize_meeting and lands the widget in the done state.
  // Split out from the processing effect below so it can be invoked either
  // immediately (0 or 1 provider configured — today's behavior, unchanged)
  // or later, from the picker's confirm button (2 providers configured), by
  // which point the effect that discovered `meetingId` has already returned.
  const runSummarization = useCallback(async (meetingId: string, provider?: ProviderKind) => {
    // Claim this as the current run. If summarizeRunRef.current no longer
    // matches `run` by the time an awaited call below resolves, the widget
    // has since left the state this run belongs to (new recording started,
    // or Done was dismissed) — every set* call, including in `finally`, must
    // then be skipped so a late-arriving regenerate cannot yank the UI back.
    const run = ++summarizeRunRef.current;
    setProcessingStatus("summarizing");
    try {
      // Called with only one argument (no explicit `undefined` forwarded)
      // when there is nothing to override, so the zero-provider path is
      // observably identical to the pre-picker call site.
      const result = provider
        ? await summarizeMeeting(meetingId, provider)
        : await summarizeMeeting(meetingId);
      if (summarizeRunRef.current !== run) return;
      setSummaryResult(result);
      // Action items are stored flat (no per-item ids) by design, so the
      // checklist keys off the array position.
      setActionItems(
        result.action_items.map((item, i) => ({
          id: String(i),
          text: item.text,
          owner: item.owner,
          completed: false,
        }))
      );
    } catch (err) {
      if (summarizeRunRef.current !== run) return;
      // The transcript is already on disk, so a summary failure is not
      // data loss — record it and still move on to the done state
      // rather than leaving the widget stuck on "Generating summary…".
      //
      // "not_configured" (no provider set up at all) is a different
      // problem from a configured-but-broken provider, and telling the
      // user to configure one when they already have would misdirect
      // them, so the two get distinct messages.
      const message = errorMessage(err);
      console.error("Summary generation failed:", message);
      setSummaryError(
        message.includes("not_configured")
          ? "Not generated — configure a provider to enable summaries."
          : "Summary generation failed. The transcript is still available."
      );
    } finally {
      if (summarizeRunRef.current === run) setState("done");
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

        // Fetched here rather than in the done state so the transcript tab
        // has content the moment it is first opened. A failure is left as an
        // empty string, which the tab renders as "Transcript unavailable." —
        // it must not block the summary below.
        try {
          setTranscriptText(await readTranscriptText(updated.id));
        } catch (err) {
          console.error("Could not read transcript:", errorMessage(err));
          setTranscriptText("");
        }

        // Determine which providers are actually usable for this run. Fetched
        // fresh here (rather than reusing the mount-time `config` state)
        // since that's what actually gates the summarize_meeting call below.
        const cfg = await getConfig().catch((err) => {
          console.error("Could not load config for provider selection:", errorMessage(err));
          return null;
        });
        if (cancelled) return;

        const available: ProviderKind[] = cfg
          ? [
              ...(cfg.claude_api_key ? (["Claude"] as const) : []),
              ...(cfg.ollama_endpoint ? (["Ollama"] as const) : []),
            ]
          : [];
        setAvailableProviders(available);

        if (available.length === 2) {
          // Both providers configured: don't auto-select — let the user
          // choose, and don't call summarizeMeeting until they confirm.
          // Because the call doesn't start until then, changing the
          // selection beforehand always changes which provider actually
          // runs; no cancellation of an in-flight call is needed.
          //
          // The default seeds from the user's persisted preference
          // (config.summary_provider, settable via the idle-state
          // ProviderPicker) when it names a provider that's actually
          // available this run, falling back to the same Ollama-preferring
          // order select_provider_kind uses on the Rust side (see
          // crates/meeting-notes-summary/src/lib.rs) when there is no
          // persisted preference or it names something unavailable. Picking
          // `available[0]` here would silently prefer Claude instead, since
          // `available` is always built Claude-first above — reversing the
          // backend's deliberate Ollama-first default and making a user's
          // explicit Ollama choice dead config the moment both are
          // configured.
          const persisted = toProviderKind(cfg?.summary_provider ?? null);
          const defaultProvider =
            persisted && available.includes(persisted)
              ? persisted
              : available.includes("Ollama")
                ? "Ollama"
                : available[0];
          setSelectedProvider(defaultProvider);
          setProcessingStatus("choosing_provider");
          return;
        }

        // 0 or 1 provider configured: unchanged from before — proceed
        // immediately with the single available provider (or with none at
        // all, letting the "not_configured" error path fire as usual).
        // available[0] is undefined in the zero-provider case; see
        // runSummarization for why that doesn't reach summarizeMeeting as an
        // explicit extra argument.
        await runSummarization(updated.id, available[0]);
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

  // Fires only from the picker shown in the "choosing_provider" sub-status
  // (two providers configured) — this is the moment the deferred
  // summarize_meeting call actually starts, using whatever was selected.
  const handleConfirmProvider = () => {
    const meeting = currentMeetingRef.current;
    if (!meeting || !selectedProvider) return;
    void runSummarization(meeting.id, selectedProvider);
  };

  // The provider not currently backing the summary on screen, among those
  // that were configured for this run. availableProviders is only populated
  // (and left populated) when exactly two providers were configured at
  // transcription-finish time, so this is null whenever there is no
  // alternate provider to regenerate with.
  //
  // Guarded on selectedProvider !== null: it is only ever set when two
  // providers were configured (see the processing effect and
  // handleRegenerate below); when just one provider is configured,
  // selectedProvider stays null while availableProviders still holds that
  // one entry. Without this guard, `p !== null` is true for that sole
  // provider, so .find would wrongly return it as "the other" provider —
  // offering to regenerate with the only provider that was ever used.
  const otherProvider = (): ProviderKind | null => {
    if (selectedProvider === null) return null;
    const other = availableProviders.find((p) => p !== selectedProvider);
    return other ?? null;
  };

  // Re-runs summarization for the same meeting with the alternate provider,
  // so the user can compare output. Reuses runSummarization rather than
  // duplicating its summarize/setSummaryResult/setActionItems/error-handling
  // body. runSummarization swallows its own errors (setSummaryError, never
  // rethrows), so there is nothing for a try/catch here to catch from that
  // call — isRegenerating only tracks the in-flight state for the button.
  const handleRegenerate = async () => {
    const target = otherProvider();
    const meeting = currentMeetingRef.current;
    if (!target || !meeting) return;
    setSummaryError(null);
    setIsRegenerating(true);
    try {
      await runSummarization(meeting.id, target);
    } finally {
      setIsRegenerating(false);
    }
    // Flip regardless of success or failure: summaryError already
    // communicates a failed attempt, and always advancing the label lets the
    // user immediately try the other provider again.
    setSelectedProvider(target);
  };

  const handleStart = async () => {
    if (busy) return;
    setBusy(true);
    setRecordingError(null);
    setElapsedSeconds(0);
    setQualityWarning(null);
    setTranscriptionError(null);
    // Clear the previous meeting's results, or they would still be on screen
    // when this recording reaches the done state.
    setSummaryResult(null);
    setSummaryError(null);
    setActionItems([]);
    setTranscriptText("");
    // Invalidate any regenerate still in flight for the previous meeting —
    // see summarizeRunRef above. Without this, a stale regenerate resolving
    // after this new recording starts would overwrite the state above with
    // the old meeting's summary.
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
        updateMeetingStatus({ ...currentMeetingRef.current, status: "Failed" }).catch((e) =>
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
          await updateMeetingStatus(transcribing);
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

  const toggleActionItem = (id: string) => {
    setActionItems((items) =>
      items.map((item) => (item.id === id ? { ...item, completed: !item.completed } : item))
    );
  };

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
        // matters more here: this pill can hold a Retry button, a provider
        // Select and a Generate Summary button, all of which would otherwise
        // have their mousedown turned into a window drag on the way up.
        onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
        className="h-full w-full flex items-center justify-center gap-2 bg-background border rounded-full px-3 py-2 shadow-sm text-sm text-muted-foreground"
      >
        {qualityWarning && (
          // Fixed-size pill (260x56), so an arbitrary-length backend string
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
          </div>
        ) : processingStatus === "choosing_provider" ? (
          // Shown only when transcription just finished and more than one
          // provider is configured — see the processing effect above. The
          // summarize_meeting call is deliberately deferred until Generate
          // Summary is clicked, so switching the selection here always
          // changes which provider actually runs.
          <div className="flex items-center gap-1.5">
            <Select
              value={selectedProvider ?? undefined}
              onValueChange={(next) => setSelectedProvider(next as ProviderKind)}
            >
              {/* Height comes from the size prop, not a className:
                  SelectTrigger's own data-[size=*] rules outrank a plain
                  h-* utility, so an override there is silently dropped. */}
              <SelectTrigger
                size="sm"
                aria-label="Summary provider"
                className="text-xs w-[88px] flex-shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableProviders.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="xs"
              onClick={handleConfirmProvider}
              disabled={!selectedProvider}
              className="flex-shrink-0"
            >
              Generate Summary
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex-shrink-0" />
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-xs truncate">
                {processingStatus === "transcribing" ? "Transcribing…" : "Generating summary…"}
              </span>
              {processingStatus === "summarizing" && (
                <span className="text-[9px] truncate">
                  Long meetings are summarized in several passes — this may take a few minutes.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // The meeting-type icon+label to show as a Badge in the Done header,
  // reusing the same list the idle-state MeetingTypePicker renders from so
  // the two never drift. currentMeetingRef.current?.meeting_type is the
  // MeetingType chosen (or auto-detected) for this meeting -- distinct from
  // summaryResult.meeting_type, which is a free-form string the model wrote
  // for the saved notes, not this fixed set of values.
  const doneMeetingType = MEETING_TYPES.find(
    (type) => type.value === currentMeetingRef.current?.meeting_type
  );

  return (
    <div className="flex flex-col gap-2 h-full text-sm">
      {qualityWarning && <span className="text-xs text-amber-600">{qualityWarning}</span>}
      <div className="flex items-center gap-2 min-w-0">
        {doneMeetingType && (
          <Badge variant="outline" className="flex-shrink-0 gap-1">
            <doneMeetingType.icon className="text-muted-foreground" />
            {doneMeetingType.label}
          </Badge>
        )}
        {summaryResult &&
          (summaryResult.attendees.length > 0 ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="flex -space-x-2 flex-shrink-0">
                {summaryResult.attendees.map((name, i) => (
                  // role="img" + aria-label rather than a bare title: the
                  // visible content is only the initials, and title alone on a
                  // non-interactive element has unreliable screen-reader
                  // support. Matches the micOnlyWarning/qualityWarning
                  // indicators above; title stays for the hover tooltip.
                  <Avatar
                    key={i}
                    role="img"
                    aria-label={name}
                    title={name}
                    className="h-6 w-6 border-2 border-background"
                  >
                    <AvatarFallback>{initials(name)}</AvatarFallback>
                  </Avatar>
                ))}
              </div>
              {summaryResult.referenced_people.length > 0 && (
                // Referenced-but-unconfirmed people are a distinct category
                // from confirmed attendees, so they stay out of the avatar
                // pile and get a compact caption instead -- see the wording
                // in notes_markdown.rs, which this deliberately mirrors.
                <span className="text-xs text-muted-foreground truncate">
                  · also referenced: {summaryResult.referenced_people.join(", ")}
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Attendees not identified</span>
          ))}
      </div>
      <Tabs defaultValue="summary" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="grid grid-cols-3">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="actions">Action Items</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="overflow-y-auto flex-1">
          {summaryResult ? (
            <div className="space-y-3">
              {summaryError && (
                // A regenerate failure (e.g. Ollama not running) must not
                // erase a summary that already loaded successfully — show it
                // as a banner above the still-rendered summary rather than
                // replacing it, the way the error-only branch below does for
                // a first-generation failure (where there is nothing to
                // preserve).
                <p role="alert" className="text-xs text-red-600">
                  {summaryError}
                </p>
              )}
              <p>{summaryResult?.summary}</p>
              {summaryResult?.topics.map(
                (topic, i) =>
                  topic.points.length > 0 && (
                    <div key={i}>
                      <h3 className="font-medium">{topic.title}</h3>
                      <ul className="list-disc pl-4">
                        {topic.points.map((point, j) => (
                          <li key={j}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  )
              )}
              {summaryResult && summaryResult.decisions.length > 0 && (
                <div>
                  <h3 className="font-medium">Decisions</h3>
                  <ul className="list-disc pl-4">
                    {summaryResult.decisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {summaryResult && summaryResult.open_questions.length > 0 && (
                <div>
                  <h3 className="font-medium">Open Questions</h3>
                  <ul className="list-disc pl-4">
                    {summaryResult.open_questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : summaryError ? (
            // No summary was ever generated for this meeting (first-attempt
            // failure) — nothing to preserve, so the error stands alone.
            <p className="text-xs text-muted-foreground">{summaryError}</p>
          ) : null}
        </TabsContent>
        <TabsContent value="actions" className="overflow-y-auto flex-1">
          {actionItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No action items found.</p>
          ) : (
            <ul className="space-y-2">
              {actionItems.map((item) => (
                <li key={item.id} className="flex items-start gap-2">
                  <Checkbox
                    id={`action-item-${item.id}`}
                    checked={item.completed}
                    onCheckedChange={() => toggleActionItem(item.id)}
                  />
                  <label
                    htmlFor={`action-item-${item.id}`}
                    className={
                      item.completed
                        ? "flex flex-1 flex-wrap items-center gap-1.5 line-through text-muted-foreground"
                        : "flex flex-1 flex-wrap items-center gap-1.5"
                    }
                  >
                    {item.text}
                    {item.owner && <Badge variant="secondary">{item.owner}</Badge>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="transcript" className="overflow-y-auto flex-1 text-xs">
          {transcriptText || "Transcript unavailable."}
        </TabsContent>
      </Tabs>
      <Separator />
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Leaving Done invalidates any regenerate still in flight — see
            // summarizeRunRef above — so it cannot land later and yank the
            // UI back to this (now stale) meeting's Done screen.
            summarizeRunRef.current++;
            setState("idle");
          }}
        >
          New Recording
        </Button>
        <Button
          variant="success"
          size="sm"
          onClick={() => {
            summarizeRunRef.current++;
            setState("idle");
          }}
        >
          Save &amp; Close
        </Button>
        {otherProvider() && (
          <Button variant="ghost" size="sm" onClick={handleRegenerate} disabled={isRegenerating}>
            {isRegenerating ? "Regenerating…" : `Regenerate with ${otherProvider()}`}
          </Button>
        )}
      </div>
    </div>
  );
}

// Initials for the Done-state attendee face-pile: first letter of each
// space-separated word, capped at two characters, uppercased -- e.g.
// "Parker" -> "P", "Devi Shah" -> "DS".
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function meetingsDataDir(): Promise<string> {
  return getDataDir();
}
