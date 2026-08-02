import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startRecording, stopRecording } from "@/lib/recording";
import { createNewMeeting, getDataDir, updateMeetingStatus, type MeetingMeta } from "@/lib/storage";
import { transcribeMeeting, onTranscriptionComplete } from "@/lib/transcription";
import { getConfig } from "@/lib/config";
import { summarizeMeeting, type SummaryResult } from "@/lib/summary";
import { Waveform } from "@/components/Waveform";

type WidgetState = "idle" | "recording" | "processing" | "done";
type ProcessingStatus = "transcribing" | "summarizing";

export function RecorderWidget() {
  const [state, setState] = useState<WidgetState>("idle");
  const [title, setTitle] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [micOnlyWarning, setMicOnlyWarning] = useState(false);
  const [qualityWarning, setQualityWarning] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>("transcribing");
  const [summaryResult, setSummaryResult] = useState<SummaryResult | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentMeetingRef = useRef<MeetingMeta | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Wall-clock start time, so the elapsed timer cannot drift when ticks are throttled.
  const startedAtRef = useRef<number>(0);

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
        try {
          setSummaryResult(await summarizeMeeting(updated.id));
        } catch (err) {
          // The transcript is already on disk, so a summary failure is not
          // data loss — record it and still move on to the done state
          // rather than leaving the widget stuck on "Generating summary…".
          console.error("Summary generation failed:", errorMessage(err));
          setSummaryError(errorMessage(err));
        } finally {
          setState("done");
        }
      });
      unlisten = stopListening;
      if (cancelled) {
        // Cleanup already ran before this listener finished registering —
        // this invocation was abandoned (e.g. StrictMode's discarded first
        // run). Unsubscribe immediately and never call transcribeMeeting.
        stopListening();
        return;
      }

      try {
        const config = await getConfig();
        if (cancelled) return;
        await transcribeMeeting(currentMeetingRef.current!, config.whisper_model ?? "base.en");
      } catch (err) {
        if (!cancelled) {
          console.error("Transcription failed:", errorMessage(err));
          setTranscriptionError(`Transcription failed: ${errorMessage(err)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [state]);

  const handleStart = async () => {
    if (busy) return;
    setBusy(true);
    setRecordingError(null);
    setElapsedSeconds(0);
    setQualityWarning(null);
    setTranscriptionError(null);
    try {
      const meeting = await createNewMeeting(title);
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
        <Input
          placeholder="Meeting title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button onClick={handleStart} disabled={busy}>
          Start Recording
        </Button>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className="flex flex-col gap-3 h-full justify-center items-center">
        {errorNotice}
        {micOnlyWarning && (
          <span className="text-xs text-amber-600">
            System audio unavailable — recording mic only
          </span>
        )}
        <Waveform active={state === "recording"} />
        <div className="text-2xl font-mono">{formattedTime}</div>
        <Button variant="destructive" onClick={handleStop} disabled={busy}>
          Stop Recording
        </Button>
      </div>
    );
  }

  if (state === "processing") {
    return (
      <div className="flex flex-col gap-2 h-full justify-center items-center text-sm text-muted-foreground">
        {qualityWarning && <span className="text-xs text-amber-600">{qualityWarning}</span>}
        {transcriptionError ? (
          <span role="alert" className="text-xs text-red-600">
            {transcriptionError}
          </span>
        ) : (
          <span>{processingStatus === "transcribing" ? "Transcribing…" : "Generating summary…"}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 h-full overflow-y-auto text-sm">
      {qualityWarning && <span className="text-xs text-amber-600">{qualityWarning}</span>}
      {summaryError ? (
        <p className="text-xs text-muted-foreground">
          Not generated — configure a provider to enable summaries.
        </p>
      ) : (
        <p>{summaryResult?.summary}</p>
      )}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function meetingsDataDir(): Promise<string> {
  return getDataDir();
}
