import { useEffect, type RefObject } from "react";
import { currentMonitor } from "@tauri-apps/api/window";
import { animateResize, currentWindowSize } from "@/lib/windowAnimation";

// Resizes the OS window to match the content's natural height, so panels
// taller than the widget's default 300px (e.g. the config panel) grow the
// window instead of scrolling internally -- up to a per-monitor cap (or a
// tighter caller-supplied `maxHeightOverride`, e.g. Meeting History's own
// 600px cap in App.tsx). Beyond that cap the window simply stops growing;
// none of the current panels wire up an internal scroll fallback of their
// own, so content past the cap is clipped by App.tsx's `overflow-hidden`
// wrapper around each panel. Without a cap at all, unusually tall content
// (e.g. a long meeting history list) could grow the window taller than the
// screen, which both hides content with no way to reach it and can push
// the title bar (the only drag handle) off-screen, making the window
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
  // so swapping in much shorter content (e.g. closing ConfigDialog or
  // History back to the plain Idle screen) never changes any observed
  // element's own box size. Including this
  // value in the effect's dependency list tears down and rebuilds the
  // observer whenever it changes, and a freshly-observed element always
  // gets measured once even with no size change -- exactly the signal
  // ResizeObserver alone cannot provide here.
  remeasureKey?: unknown,
  // A hard cap tighter than the monitor-fraction cap, for content that
  // should never grow as tall as the rest of that percentage would allow
  // (e.g. Meeting History's 600px cap, regardless of monitor size).
  // Ignored when the monitor-fraction cap is already lower.
  maxHeightOverride?: number
) {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    // measure() awaits real Tauri IPC round-trips (currentMonitor(),
    // currentWindowSize()), so it can still be suspended when this effect run
    // is torn down -- e.g. the widget leaves Idle for the
    // Recording/Processing pill mid-measure. `cancelled` stops a torn-down
    // run from writing a stale size after the fact; `latestRun` stops an
    // older in-flight measure() from clobbering a newer one if the
    // ResizeObserver fires twice before the first resolves (out-of-order
    // resolution). Both are needed -- they guard different failure modes.
    // The same staleness check also cancels an in-flight resize *animation*:
    // if content changes again before the previous animation finishes, the
    // old animation stops on its next frame instead of fighting the new one.
    let cancelled = false;
    let latestRun = 0;

    const measure = async () => {
      const run = ++latestRun;
      // Shared by every staleness check below, and passed as animateResize's
      // cancellation check: if a newer measure() starts (a fresh
      // ResizeObserver fire, or this effect tearing down), an in-flight
      // resize animation from an older run stops on its next frame instead
      // of fighting the newer target.
      const isStale = () => cancelled || run !== latestRun;

      // Read scrollHeight with any previously-applied pin lifted first,
      // then restore it immediately -- synchronously, so no frame is ever
      // painted unpinned. Reading it WHILE pinned corrupts the signal:
      // once a height is applied to `el`, the overflow-hidden wrapper
      // around it (App.tsx's `flex-1 overflow-hidden` div, around either
      // panel's own `h-full` root -- see MeetingHistory.tsx/
      // RecorderWidget.tsx) clips all of the content's overflow, so `el`'s
      // children report their own *allotted* box size back as
      // `scrollHeight`, not the content's true size. Reading that shrunken
      // number back as `total` here would ratchet the window smaller by
      // (2x the root's border width) on every single measurement, forever,
      // instead of ever settling at the cap.
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
      if (isStale()) return;

      const heightCap = Math.min(
        monitor
          ? monitor.workArea.size.toLogical(monitor.scaleFactor).height * HEIGHT_CAP_FRACTION
          : FALLBACK_HEIGHT_CAP,
        maxHeightOverride ?? Infinity
      );

      const height = Math.min(heightCap, Math.max(minHeight, total));

      // Eases from wherever the window actually is right now to the newly
      // computed target instead of snapping -- see windowAnimation.ts. A
      // failure here (e.g. no real Tauri runtime) falls back to animating
      // from the target to itself, which is a same-value no-op rather than
      // a crash.
      const from = await currentWindowSize().catch((err) => {
        console.error("useAutoResizeWindow: could not read current window size", err);
        return { width, height };
      });
      if (isStale()) return;

      animateResize(from, { width, height }, isStale).catch((err) =>
        console.error("useAutoResizeWindow: animateResize failed", err)
      );

      // Gives the DOM an explicit, JS-computed bound equal to the same value
      // just sent to the OS window -- deliberately never a viewport-relative
      // unit (100vh/h-screen), and deliberately applied only AFTER `total`
      // was already read above with the pin lifted, so this write can never
      // feed back into the next measurement's own reading of `total`. This
      // keeps `el`'s own box height in lockstep with the OS window size
      // that was just requested, so content past the cap stays clipped by
      // App.tsx's `overflow-hidden` wrapper instead of silently
      // overflowing past the window's visible edge while the resize
      // animation is still catching up. Set synchronously here (not
      // animated in JS) -- App.tsx gives the root
      // element a matching CSS transition so this value change animates in
      // lockstep with the JS-driven window resize above.
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
      // capped Idle-state panel (e.g. a long Meeting History list) would
      // linger on the same DOM node and fight the pill's own
      // `h-screen w-screen` sizing the next time this hook is re-enabled.
      el.style.height = "";
    };
  }, [ref, width, minHeight, enabled, remeasureKey, maxHeightOverride]);
}
