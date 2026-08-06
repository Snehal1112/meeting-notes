import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

// Tauri's setSize() has no built-in transition -- it snaps instantly. To make
// a resize feel intentional rather than jarring, step through intermediate
// sizes over a short duration with an ease-out curve. This is a manual
// animation of the actual OS window frame, not a CSS transition (CSS can't
// touch native window dimensions, only content drawn inside them). Shared by
// App.tsx's Recording <-> Processing pill transition and by
// useAutoResizeWindow's content-driven resizes.
//
// Caveat: stepping setSize() at animation-frame rate can look stepped/janky
// rather than smooth on some Linux window managers (particularly X11) --
// this could not be visually verified in this implementing environment (no
// display/Tauri runtime available here). If it looks janky in practice, the
// fallback is a single non-animated setSize() call straight to the target.
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// `isCancelled` is re-checked on every frame, before writing a size and before
// scheduling the next one, so an abandoned animation stops on its very next
// frame instead of running to completion. Without it two overlapping resize
// requests (e.g. a fast widgetState change, or new content arriving mid
// content-driven resize) would leave two animations writing conflicting sizes
// to the same window at animation-frame rate.
export async function animateResize(
  from: { width: number; height: number },
  to: { width: number; height: number },
  isCancelled: () => boolean = () => false,
  durationMs = 180
): Promise<void> {
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

// Reads the window's actual current logical size, so a resize animation can
// ease from wherever the window really is right now instead of assuming a
// stale previously-known size. Queried fresh every call (never cached), so
// there is nothing to go stale between callers.
export async function currentWindowSize(): Promise<{ width: number; height: number }> {
  const win = getCurrentWindow();
  const [physical, scaleFactor] = await Promise.all([win.innerSize(), win.scaleFactor()]);
  const logical = physical.toLogical(scaleFactor);
  return { width: logical.width, height: logical.height };
}
