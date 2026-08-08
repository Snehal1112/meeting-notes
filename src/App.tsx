import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "@/components/TitleBar";
import { ConfigDialog } from "@/components/ConfigDialog";
import { RecorderWidget, type WidgetState } from "@/components/RecorderWidget";
import { ResumePrompt } from "@/components/ResumePrompt";
import { MeetingHistory } from "@/components/MeetingHistory";
import { MicActivityBanner } from "@/components/MicActivityBanner";
import { configNeedsSetup, saveConfig, type AppConfig } from "@/lib/config";
import { getOrphanedMeetings, type MeetingMeta } from "@/lib/storage";
import { animateResize, currentWindowSize } from "@/lib/windowAnimation";
import { useAutoResizeWindow } from "@/hooks/useAutoResizeWindow";
import { setClickThroughTracking } from "@/lib/window";

// Fixed pill sizes for the chrome-less Recording/Processing window. Idle and
// Done are deliberately not represented here -- their sizing stays owned by
// useAutoResizeWindow's content measurement below (see the effect that
// drives this table), so a fixed size for those two states would regress the
// config dialog's ability to grow the window taller than 300px.
const PILL_SIZES: Record<"recording" | "processing", { width: number; height: number }> = {
  recording: { width: 224, height: 56 },
  // Sized for the SummaryChecklist card (3 step rows + label + optional
  // chunk-progress line, see SummaryChecklist.tsx), not the compact single
  // line this pill originally held. Applies for the whole Processing state
  // -- both the Transcribing and Summarizing sub-statuses -- rather than
  // resizing a second time when the checklist actually appears, since
  // Transcribing spends only a few seconds in a slightly-too-tall card and
  // a second resize isn't worth threading ProcessingStatus up from
  // RecorderWidget into this table just for that.
  processing: { width: 340, height: 220 },
};

function App() {
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [orphaned, setOrphaned] = useState<MeetingMeta[]>([]);
  const [resumeMeeting, setResumeMeeting] = useState<MeetingMeta | null>(null);
  const [widgetState, setWidgetState] = useState<WidgetState>("idle");
  // Bumped every time the system tray's "New Recording" menu item fires the
  // "tray-new-recording" event (see the listener effect below). A counter
  // rather than a boolean so a second click while the first is still
  // pending (or ignored, e.g. mid-recording) is still a distinct, detectable
  // change for RecorderWidget's own triggerNewRecording effect to react to.
  const [trayNewRecordingSignal, setTrayNewRecordingSignal] = useState(0);
  const [showMicBanner, setShowMicBanner] = useState(false);
  // Clears an ignored mic-activity banner the moment the widget leaves Idle
  // for any reason (regardless of whether the user started a recording
  // directly, resumed an interrupted one, or retried a failed one from
  // History). WidgetState only has three values -- "idle" | "recording" |
  // "processing" (see RecorderWidget.tsx) -- and both the resume path
  // (RecorderWidget's resumeMeeting effect) and the retry path
  // (handleRetryMeeting below) jump straight from idle to "processing",
  // never passing through "recording". Clearing on "recording" alone missed
  // those: the banner would merely be hidden by the isPill guard during
  // Processing, not cleared, and would reappear once that unrelated
  // resume/retry finished and the widget returned to Idle, falsely implying
  // fresh mic activity.
  const handleWidgetStateChange = useCallback((state: WidgetState) => {
    setWidgetState(state);
    if (state !== "idle") {
      setShowMicBanner(false);
    }
  }, []);
  // Bumped whenever MeetingHistory's own content changes (pagination,
  // search/filter results, a row refreshed after re-run/delete) -- folded
  // into remeasureKey below. MeetingHistory's wrapper div is flex-stretched
  // to fill whatever height the window is already pinned to, so its own box
  // never changes size even when its content does; useAutoResizeWindow's
  // ResizeObserver has nothing to react to on its own for those internal
  // state changes, the same way it wouldn't for a widgetState transition
  // without remeasureKey (see that hook's comments).
  const [historyContentVersion, setHistoryContentVersion] = useState(0);
  const handleHistoryContentChange = useCallback(() => {
    setHistoryContentVersion((v) => v + 1);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  // Generation counter for the pill resize animation, mirroring
  // RecorderWidget's summarizeRunRef: bumped whenever the widget state
  // changes, so any animation still in flight for the previous state stops
  // writing sizes on its next frame rather than fighting the current one.
  const resizeRunRef = useRef(0);
  // Which of the two sizing owners is active. Recording and Processing are
  // fixed-size pills (PILL_SIZES below); Idle and Done size themselves from
  // their content. Declared before the hooks that depend on it so both can
  // key off the same value.
  const isPill = widgetState === "recording" || widgetState === "processing";
  // Switched off entirely while the pill owns the window size. Detaching
  // rootRef is not sufficient -- see the comment on useAutoResizeWindow for
  // why an already-created ResizeObserver keeps firing regardless, and would
  // pull the window back to 400x300 mid-animation.
  //
  // widgetState, showConfigDialog, and showHistory are all passed as
  // remeasureKey: once the root's height is pinned (e.g. after a long
  // Done-state summary, or after the taller ConfigDialog/History panels),
  // its flex-1 children stretch to fill that space rather than shrinking to
  // content, so swapping in shorter content -- "New Recording" replacing
  // Done with Idle, or closing ConfigDialog/History back to the
  // RecorderWidget -- never changes any observed element's own box size on
  // its own -- ResizeObserver has nothing to react to. Combining all three
  // into one key forces a fresh measurement on every such transition
  // instead.
  //
  // History gets its own 600px cap, independent of the monitor-fraction cap
  // the other states share -- a long meeting list on a large monitor
  // shouldn't grow the window arbitrarily tall the way a Done-state summary
  // legitimately can.
  useAutoResizeWindow(
    rootRef,
    400,
    300,
    !isPill,
    `${widgetState}:${showConfigDialog}:${showHistory}:${historyContentVersion}`,
    showHistory ? 600 : undefined
  );

  // Drives the pill's own size during Recording/Processing only. Idle/Done
  // intentionally do not run this -- see PILL_SIZES above.
  useEffect(() => {
    if (widgetState !== "recording" && widgetState !== "processing") {
      // Leaving pill mode: invalidate any in-flight animation so it stops
      // resizing a window that useAutoResizeWindow now owns again.
      resizeRunRef.current++;
      return;
    }
    const run = ++resizeRunRef.current;
    const isCancelled = () => resizeRunRef.current !== run;
    const targetSize = PILL_SIZES[widgetState];
    (async () => {
      const from = await currentWindowSize().catch((err) => {
        console.error("Could not read current window size for resize animation:", err);
        return targetSize;
      });
      if (isCancelled()) return;
      await animateResize(from, targetSize, isCancelled);
      // animateResize itself calls getCurrentWindow(), which throws
      // synchronously outside of a real Tauri runtime (e.g. jsdom in
      // tests) -- caught here so a resize failure never crashes the
      // widget-state effect, consistent with every other Tauri call in
      // this file being logged rather than left to bubble up.
    })().catch((err) => console.error("Pill resize animation failed:", err));
    return () => {
      resizeRunRef.current++;
    };
  }, [widgetState]);

  // Makes the pill's transparent corners (outside its rounded-full shape,
  // but still inside the actual rectangular OS window) click-through --
  // see src-tauri/src/commands/window_commands.rs for why this needs a
  // Rust-side poll loop rather than a JS mousemove listener. Idle is
  // deliberately excluded: its corner radius is small enough (rounded-lg)
  // that the same problem there is not worth the tracking overhead.
  useEffect(() => {
    void setClickThroughTracking(isPill).catch((err) =>
      console.error("Could not toggle click-through tracking:", err)
    );
  }, [isPill]);

  useEffect(() => {
    configNeedsSetup().then(setShowConfigDialog);
  }, []);

  // A recording left at "Recording" in the index means a previous session
  // was interrupted mid-capture. Its partial audio is still on disk and is
  // worth transcribing, so offer it on launch. A failure here must not stop
  // the user from recording, so it is logged rather than surfaced.
  useEffect(() => {
    getOrphanedMeetings()
      .then(setOrphaned)
      .catch((err) => console.error("Could not check for interrupted recordings:", err));
  }, []);

  // Surfaces the widget and offers to start recording the moment another
  // app (Zoom, a browser tab) opens a mic-capture stream, so the user
  // doesn't have to remember to switch over and click Start Recording
  // themselves. Mirrors onTranscriptionComplete's cancelled-guard pattern
  // (see RecorderWidget.tsx) to survive React StrictMode's double-invoke
  // without double-registering the listener.
  //
  // showHistory/showConfigDialog are also checked here (and listed as
  // deps) -- neither changes widgetState (both overlay Idle without
  // touching it), so without this guard an event arriving while either is
  // open would still flip showMicBanner to true underneath it. The render
  // guard would hide it in the moment, same as it does for a banner shown
  // before the overlay opened, but see the effect below for why that's not
  // enough on its own.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const stopListening = await listen("external-mic-activity", () => {
        if (cancelled) return;
        if (widgetState === "idle" && !showHistory && !showConfigDialog) {
          getCurrentWindow().setFocus().catch((err) =>
            console.error("Could not focus window for mic activity:", err)
          );
          setShowMicBanner(true);
        }
        // Deliberately no-op if already recording/processing, or if History/
        // Settings is open -- the user is already doing the thing this
        // banner would have suggested, or is busy elsewhere and shouldn't
        // be interrupted by chrome popping up behind an open panel.
      });
      if (cancelled) {
        stopListening();
        return;
      }
      unlisten = stopListening;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [widgetState, showHistory, showConfigDialog]);

  // Clears a shown-while-idle mic-activity banner the moment History or
  // Settings opens. Regression guard: the render guard on MicActivityBanner
  // below (`!showHistory`, `!showConfigDialog`) only hides an already-shown
  // banner while either panel is open -- it doesn't clear showMicBanner
  // itself. Without this effect, a banner shown before the user opened
  // History/Settings would silently reappear the moment they closed it,
  // even though no new mic activity happened while they were away.
  useEffect(() => {
    if (showHistory || showConfigDialog) {
      setShowMicBanner(false);
    }
  }, [showHistory, showConfigDialog]);

  // Surfaces a real "start recording" the moment the system tray's "New
  // Recording" menu item is clicked (see src-tauri/src/lib.rs's
  // on_menu_event, which shows/focuses the window and emits this event).
  // Mirrors the external-mic-activity listener effect above's
  // cancelled-guard pattern to survive React StrictMode's double-invoke
  // without double-registering the listener. The actual "is a recording
  // already in progress" guard lives inside RecorderWidget's own
  // triggerNewRecording effect, next to handleStart itself, rather than
  // being duplicated here from widgetState.
  //
  // showHistory/showConfigDialog are checked here for the same reason as
  // the external-mic-activity effect above: RecorderWidget unmounts while
  // either panel is open (see the render guard further down), so bumping
  // the signal now would be silently lost -- prevTriggerNewRecordingRef
  // would initialize to the already-bumped value on remount and never see
  // a change. Deliberately no-op while a panel is open rather than queuing
  // the request; the user can just click "New Recording" again once they
  // close it.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      const stopListening = await listen("tray-new-recording", () => {
        if (cancelled) return;
        if (!showHistory && !showConfigDialog) {
          setTrayNewRecordingSignal((n) => n + 1);
        }
      });
      if (cancelled) {
        stopListening();
        return;
      }
      unlisten = stopListening;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showHistory, showConfigDialog]);

  const handleResume = (id: string) => {
    const meeting = orphaned.find((m) => m.id === id);
    if (!meeting) return;
    setResumeMeeting(meeting);
    setOrphaned((prev) => prev.filter((m) => m.id !== id));
  };

  // Retrying a Failed meeting from History reuses the exact same
  // "resumeMeeting" hand-off handleResume uses for an interrupted
  // recording: closing History and setting this re-enters RecorderWidget's
  // processing effect directly, re-running transcription (and, on success,
  // summarization) from where it failed.
  const handleRetryMeeting = (meeting: MeetingMeta) => {
    setShowHistory(false);
    setResumeMeeting(meeting);
  };

  const handleSave = async (config: AppConfig) => {
    await saveConfig(config);
    setShowConfigDialog(false);
  };

  const handleSkip = () => setShowConfigDialog(false);

  // Recording and Processing: no title bar, no card border, no
  // ConfigDialog/ResumePrompt -- none of those can be relevant mid-recording
  // (same reasoning as ConfigDialog already not appearing then: it's only
  // ever shown at first launch, well before a recording could be in
  // progress). The pill itself -- styled inside RecorderWidget -- is the
  // entire visible window, floating on transparent space.
  //
  // RecorderWidget is written ONCE below, as the last child in a single
  // return tree, and stays in that same JSX slot (same type, same position
  // among siblings) across every widgetState transition -- only the chrome
  // *around* it (TitleBar, ConfigDialog, ResumePrompt, the card border, the
  // wrapper className) is what varies conditionally. This matters: React's
  // reconciler matches children by type+position, not by "this is
  // conceptually the same component". Two structurally different return
  // trees that each construct their own <RecorderWidget> element -- even if
  // both are "just" a RecorderWidget somewhere inside a div -- would look
  // like a type mismatch at that position the moment the surrounding shape
  // differs, and React would tear down the whole subtree and mount a fresh
  // instance. That would drop currentMeetingRef, the elapsed-time timer, and
  // the live onTranscriptionComplete listener right as a recording starts or
  // transcription is in flight -- see the remount-detection test in
  // App.test.tsx for the regression this guards against. (isPill itself is
  // declared up with the sizing hooks above, which key off the same value.)

  return (
    <>
      {/* Mounted once, outside the pill/full-chrome split -- toasts (meeting
          history's delete-undo) are only ever triggered from full-chrome
          state, but the component itself is a fixed-position overlay that
          doesn't participate in rootRef's content measurement either way. */}
      <Toaster position="bottom-center" />
      <div
        ref={isPill ? undefined : rootRef}
      className={
        isPill
          ? "h-screen w-screen flex items-center justify-center bg-transparent"
          : // shadow-widget is the design-token elevation that lifts the
            // full-chrome container off the transparent OS window; the pill
            // carries its own smaller shadow-sm instead. The transition
            // matches animateResize's 180ms ease-out-cubic timing (see
            // windowAnimation.ts) so this element's JS-set explicit height
            // (useAutoResizeWindow.ts) animates in lockstep with the
            // window's own JS-driven resize instead of snapping ahead of it.
            "min-h-[300px] flex flex-col rounded-lg overflow-hidden border shadow-widget bg-background transition-[height] duration-[180ms] ease-[cubic-bezier(0.33,1,0.68,1)]"
      }
    >
      {!isPill && (
        <TitleBar
          onOpenSettings={() => {
            setShowHistory(false);
            setShowConfigDialog(true);
          }}
          onOpenHistory={() => {
            setShowConfigDialog(false);
            setShowHistory(true);
          }}
        />
      )}
      {!isPill && showConfigDialog && (
        <ConfigDialog open={showConfigDialog} onSave={handleSave} onSkip={handleSkip} />
      )}
      {!isPill && !showConfigDialog && !showHistory && (
        <ResumePrompt
          meetings={orphaned}
          onResume={handleResume}
          onDismiss={(id) => setOrphaned((prev) => prev.filter((m) => m.id !== id))}
        />
      )}
      {!isPill && !showConfigDialog && !showHistory && showMicBanner && (
        <MicActivityBanner onDismiss={() => setShowMicBanner(false)} />
      )}
      {!isPill && !showConfigDialog && showHistory && (
        <div className="flex-1 p-4 overflow-hidden">
          <MeetingHistory
            onBack={() => setShowHistory(false)}
            onRetryMeeting={handleRetryMeeting}
            onContentChange={handleHistoryContentChange}
          />
        </div>
      )}
      {(isPill || (!showConfigDialog && !showHistory)) && (
        <div className={isPill ? undefined : "flex-1 p-4 overflow-hidden"}>
          <RecorderWidget
            resumeMeeting={resumeMeeting}
            onStateChange={handleWidgetStateChange}
            triggerNewRecording={trayNewRecordingSignal}
          />
        </div>
      )}
      </div>
    </>
  );
}

export default App;
