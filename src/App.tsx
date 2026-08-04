import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { TitleBar } from "@/components/TitleBar";
import { ConfigDialog } from "@/components/ConfigDialog";
import { RecorderWidget, type WidgetState } from "@/components/RecorderWidget";
import { ResumePrompt } from "@/components/ResumePrompt";
import { configNeedsSetup, saveConfig, type AppConfig } from "@/lib/config";
import { getOrphanedMeetings, type MeetingMeta } from "@/lib/storage";
import { useAutoResizeWindow } from "@/hooks/useAutoResizeWindow";

// Tauri's setSize() has no built-in transition -- it snaps instantly. To make
// the Recording <-> Processing pill resize feel intentional rather than
// jarring, step through intermediate sizes over a short duration with an
// ease-out curve. This is a manual animation of the actual OS window frame,
// not a CSS transition (CSS can't touch native window dimensions, only
// content drawn inside them).
//
// Caveat: stepping setSize() at animation-frame rate can look stepped/janky
// rather than smooth on some Linux window managers (particularly X11) --
// this could not be visually verified in this implementing environment (no
// display/Tauri runtime available here). If it looks janky in practice, the
// fallback is a single non-animated setSize() call straight to the target.
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// `isCancelled` is re-checked on every frame, before writing a size and before
// scheduling the next one, so an abandoned animation stops on its very next
// frame instead of running to completion. Without it a fast state change
// (recording -> processing inside the 180ms window, or handleStop failing
// straight back to idle) would leave two animations writing conflicting sizes
// to the same window at animation-frame rate.
async function animateResize(
  from: { width: number; height: number },
  to: { width: number; height: number },
  isCancelled: () => boolean = () => false,
  durationMs = 180
) {
  const win = getCurrentWindow();
  const start = performance.now();

  return new Promise<void>((resolve) => {
    function step(now: number) {
      if (isCancelled()) {
        resolve();
        return;
      }
      const elapsed = now - start;
      const t = Math.min(elapsed / durationMs, 1);
      const eased = easeOutCubic(t);
      const width = from.width + (to.width - from.width) * eased;
      const height = from.height + (to.height - from.height) * eased;
      win
        .setSize(new LogicalSize(width, height))
        .catch((err) => console.error("animateResize: setSize failed", err));
      if (t < 1 && !isCancelled()) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

// Fixed pill sizes for the chrome-less Recording/Processing window. Idle and
// Done are deliberately not represented here -- their sizing stays owned by
// useAutoResizeWindow's content measurement below (see the effect that
// drives this table), so a fixed size for those two states would regress the
// config dialog's ability to grow the window taller than 300px.
const PILL_SIZES: Record<"recording" | "processing", { width: number; height: number }> = {
  recording: { width: 224, height: 56 },
  processing: { width: 260, height: 56 },
};

// Reads the window's actual current logical size, so the resize animation
// can ease from wherever the window really is right now -- e.g. the ~400x300
// full-chrome size on the very first Idle/Done -> Recording transition, or
// whatever pill size a prior Recording<->Processing hop left it at. Querying
// fresh each time (rather than caching the last pill size in a ref) means
// there is nothing to go stale across an Idle/Done detour in between
// recordings (processing -> done -> idle -> recording again).
async function currentWindowSize(): Promise<{ width: number; height: number }> {
  const win = getCurrentWindow();
  const [physical, scaleFactor] = await Promise.all([win.innerSize(), win.scaleFactor()]);
  const logical = physical.toLogical(scaleFactor);
  return { width: logical.width, height: logical.height };
}

function App() {
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [orphaned, setOrphaned] = useState<MeetingMeta[]>([]);
  const [resumeMeeting, setResumeMeeting] = useState<MeetingMeta | null>(null);
  const [widgetState, setWidgetState] = useState<WidgetState>("idle");
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
  useAutoResizeWindow(rootRef, 400, 300, !isPill);

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
    <div
      ref={isPill ? undefined : rootRef}
      className={
        isPill
          ? "h-screen w-screen flex items-center justify-center bg-transparent"
          : // shadow-widget is the design-token elevation that lifts the
            // full-chrome container off the transparent OS window; the pill
            // carries its own smaller shadow-sm instead.
            "min-h-[300px] flex flex-col rounded-lg overflow-hidden border shadow-widget bg-background"
      }
    >
      {!isPill && <TitleBar />}
      {!isPill && showConfigDialog && (
        <ConfigDialog open={showConfigDialog} onSave={handleSave} onSkip={handleSkip} />
      )}
      {!isPill && !showConfigDialog && (
        <ResumePrompt meetings={orphaned} onResume={handleResume} onDismiss={() => setOrphaned([])} />
      )}
      {(isPill || !showConfigDialog) && (
        <div className={isPill ? undefined : "flex-1 p-4"}>
          <RecorderWidget resumeMeeting={resumeMeeting} onStateChange={setWidgetState} />
        </div>
      )}
    </div>
  );
}

export default App;
