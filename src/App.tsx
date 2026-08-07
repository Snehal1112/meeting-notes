import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "sonner";
import { TitleBar } from "@/components/TitleBar";
import { ConfigDialog } from "@/components/ConfigDialog";
import { RecorderWidget, type WidgetState } from "@/components/RecorderWidget";
import { ResumePrompt } from "@/components/ResumePrompt";
import { MeetingHistory } from "@/components/MeetingHistory";
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
  // Wider than the Recording pill: this pill can hold a Retry button and
  // qualityWarning's icon, rendered in the global body font (JetBrains
  // Mono, wider per-character than the Inter it was originally sized
  // against). The width was 300px while this pill also held a two-provider
  // picker (a Select trigger + "Generate Summary" button); with that picker
  // removed, 280px is a conservative reduction -- not a full reversion to
  // the original 260px, which was already too tight for the icon and font
  // alone before the picker ever existed (see git history on this line).
  // Height is taller than the Recording pill's 56px: the "summarizing"
  // sub-status's explanatory sentence wraps to 2 lines instead of being
  // truncated to 1 (see RecorderWidget.tsx), and needs the extra vertical
  // room to avoid trading a horizontal overflow bug for a vertical one.
  processing: { width: 280, height: 64 },
};

function App() {
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [orphaned, setOrphaned] = useState<MeetingMeta[]>([]);
  const [resumeMeeting, setResumeMeeting] = useState<MeetingMeta | null>(null);
  const [widgetState, setWidgetState] = useState<WidgetState>("idle");
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
          <RecorderWidget resumeMeeting={resumeMeeting} onStateChange={setWidgetState} />
        </div>
      )}
      </div>
    </>
  );
}

export default App;
