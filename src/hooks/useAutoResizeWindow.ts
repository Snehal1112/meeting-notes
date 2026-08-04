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
  enabled = true,
  // Forces a fresh measurement on transitions ResizeObserver cannot detect
  // on its own -- e.g. App.tsx passes its widgetState. Once the root is
  // pinned to an explicit height (see measure() below), its flex-1
  // children stretch to FILL that space rather than shrinking to content,
  // so swapping in much shorter content (Done -> Idle via "New Recording")
  // never changes any observed element's own box size. Including this
  // value in the effect's dependency list tears down and rebuilds the
  // observer whenever it changes, and a freshly-observed element always
  // gets measured once even with no size change -- exactly the signal
  // ResizeObserver alone cannot provide here.
  remeasureKey?: unknown
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

      // Read scrollHeight with any previously-applied pin lifted first,
      // then restore it immediately -- synchronously, so no frame is ever
      // painted unpinned. Reading it WHILE pinned corrupts the signal:
      // once a height is applied to `el`, the flex/overflow chain below it
      // (App.tsx's wrapper -> RecorderWidget's h-full Done root -> Tabs'
      // flex-1 overflow-hidden -> each TabsContent's overflow-y-auto
      // flex-1) absorbs all of the content's overflow into its own
      // internal scroll, so `el`'s children report their own *allotted*
      // box size back as `scrollHeight`, not the content's true size.
      // Reading that shrunken number back as `total` here would ratchet
      // the window smaller by (2x the root's border width) on every single
      // measurement, forever, instead of ever settling at the cap.
      const previousHeight = el.style.height;
      el.style.height = "";
      const total = Array.from(el.children).reduce(
        (sum, child) => sum + child.scrollHeight,
        0
      );
      el.style.height = previousHeight;

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

      // Gives the DOM an explicit, JS-computed bound equal to the same value
      // just sent to the OS window -- deliberately never a viewport-relative
      // unit (100vh/h-screen), and deliberately applied only AFTER `total`
      // was already read above with the pin lifted, so this write can never
      // feed back into the next measurement's own reading of `total`. This
      // is what lets RecorderWidget.tsx's already-present `overflow-y-auto`
      // Tabs content actually activate once content exceeds the cap,
      // instead of silently overflowing past the window's visible edge.
      el.style.height = `${height}px`;
    };

    const observer = new ResizeObserver(measure);
    const children = Array.from(el.children);
    children.forEach((child) => observer.observe(child));
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      // rootRef's div is reused (not remounted) across pill <-> full-chrome
      // transitions in App.tsx -- the ref/className on that element merely
      // toggle via a ternary. Without this reset, a height forced by a
      // capped Done state would linger on the same DOM node and fight the
      // pill's own `h-screen w-screen` sizing the next time this hook is
      // re-enabled.
      el.style.height = "";
    };
  }, [ref, width, minHeight, enabled, remeasureKey]);
}
