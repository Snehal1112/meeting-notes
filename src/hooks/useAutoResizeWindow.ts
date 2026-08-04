import { useEffect, type RefObject } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

// Resizes the OS window to match the content's natural height, so panels
// taller than the widget's default 300px (e.g. the config panel) grow the
// window instead of scrolling internally -- up to a per-monitor cap. Beyond
// that cap the window stops growing and the internal overflow-y-auto panels
// in RecorderWidget.tsx's Done-state Tabs content take over instead. Without
// a cap, a long meeting summary/transcript could grow the window taller
// than the screen, which both hides content with no way to reach it and can
// push the title bar (the only drag handle) off-screen, making the window
// undraggable to another monitor.
const HEIGHT_CAP_FRACTION = 0.85;
const FALLBACK_HEIGHT_CAP = 700; // logical px, used when currentMonitor() returns null

// `enabled` is a real dependency of the effect, not a convenience flag: the
// caller needs to be able to switch this measurement off entirely while
// something else owns the window size (App.tsx's Recording/Processing pill).
// Detaching the ref is not enough to do that. Once the ResizeObserver below
// exists it keeps observing the elements it was handed, whatever `ref.current`
// later becomes, so every step of the pill's resize animation would change the
// observed content box, re-fire measure(), and set the window straight back to
// `width` x content height. Turning `enabled` off tears the observer down;
// turning it back on re-creates it, and ResizeObserver.observe() fires an
// initial callback that re-measures the content immediately.
export function useAutoResizeWindow(
  ref: RefObject<HTMLElement | null>,
  width: number,
  minHeight: number,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    // measure() awaits a real Tauri IPC round-trip (currentMonitor()), so it
    // can still be suspended when this effect run is torn down -- e.g. the
    // widget leaves Idle/Done for the Recording/Processing pill mid-measure.
    // `cancelled` stops a torn-down run from writing a stale size after the
    // fact; `latestRun` stops an older in-flight measure() from clobbering a
    // newer one if the ResizeObserver fires twice before the first resolves
    // (out-of-order resolution). Both are needed -- they guard different
    // failure modes.
    let cancelled = false;
    let latestRun = 0;

    const measure = async () => {
      const run = ++latestRun;

      // el's own scrollHeight is unreliable here: it's a flex-col container
      // with overflow-hidden, and its children (e.g. a scrollable panel) can
      // themselves be clipped to whatever height the window currently is,
      // understating how much content actually needs. Sum each direct
      // child's natural scrollHeight instead -- that's the real total.
      const total = Array.from(el.children).reduce(
        (sum, child) => sum + child.scrollHeight,
        0
      );

      // Queried fresh on every measure() call (not cached across renders) so
      // the cap always reflects whichever monitor the window is currently
      // on, even if it was dragged to a different one since the last
      // content change.
      const monitor = await currentMonitor();

      // This run was torn down or superseded while awaiting currentMonitor().
      // Do not write a stale size.
      if (cancelled || run !== latestRun) return;

      const heightCap = monitor
        ? monitor.workArea.size.toLogical(monitor.scaleFactor).height * HEIGHT_CAP_FRACTION
        : FALLBACK_HEIGHT_CAP;

      const height = Math.min(heightCap, Math.max(minHeight, total));
      getCurrentWindow()
        .setSize(new LogicalSize(width, height))
        .catch((err) => console.error("useAutoResizeWindow: setSize failed", err));
    };

    const observer = new ResizeObserver(measure);
    const children = Array.from(el.children);
    children.forEach((child) => observer.observe(child));
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [ref, width, minHeight, enabled]);
}
