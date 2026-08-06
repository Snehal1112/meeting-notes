# Smooth Animation for Content-Driven Window Resizes

**Goal:** Every time the app's window resizes itself to fit its content — opening/closing the Settings (`ConfigDialog`) panel, a Done-state summary growing the window, "New Recording" shrinking it back to Idle size, etc. — the resize should animate smoothly instead of snapping instantly. This should use the same 180ms ease-out-cubic feel the Recording↔Processing pill transition already uses, so the whole app has one consistent motion language.

**Non-goals:** Animating the Recording↔Processing pill transition itself (already animated, untouched by this work). Respecting `prefers-reduced-motion` (the existing pill animation doesn't either — not introducing a new inconsistency here). Any change to *what* size the window resizes to, the height cap, or the DOM height-pinning mechanics that make `overflow-y-auto` panels activate — only *how* the transition between sizes looks.

---

## Background

Two independent mechanisms currently drive window size in `App.tsx`:

1. **`animateResize`** (private to `App.tsx`) — a `requestAnimationFrame` loop with ease-out-cubic easing, used only for the Recording↔Processing pill's fixed-size swap. Steps `setSize()` every frame over 180ms.
2. **`useAutoResizeWindow`** (`src/hooks/useAutoResizeWindow.ts`) — measures the root element's content via `ResizeObserver`, computes a target height (clamped to a per-monitor cap), and calls `getCurrentWindow().setSize()` **once, directly** — no animation. This is what drives Idle/Done sizing and, since the `ConfigDialog` panel is just conditionally-rendered content inside the same root, what resizes the window when Settings opens or closes.

The snap the user is seeing on the Settings panel is `useAutoResizeWindow` calling `setSize()` with no easing. Since this hook is the single owner of *all* content-driven resizing (not just the config panel), animating it animates every content-driven resize uniformly.

Neither `animateResize` nor `easeOutCubic` has any dedicated unit test today — they're private to `App.tsx` and only indirectly exercised by tests that trigger a pill transition (Tauri calls throw harmlessly in jsdom and are logged, not asserted on).

## Architecture

Extract `easeOutCubic`, `animateResize`, and `currentWindowSize` out of `App.tsx` into a new shared module: `src/lib/windowAnimation.ts`. Behavior and signatures are unchanged — this is a pure relocation:

```ts
export function easeOutCubic(t: number): number;
export async function currentWindowSize(): Promise<{ width: number; height: number }>;
export async function animateResize(
  from: { width: number; height: number },
  to: { width: number; height: number },
  isCancelled?: () => boolean,
  durationMs?: number // defaults to 180
): Promise<void>;
```

- `App.tsx` imports from this module instead of defining these locally. Its Recording↔Processing pill-transition effect is otherwise untouched (same `resizeRunRef` generation-counter cancellation it already has).
- `useAutoResizeWindow.ts` imports the same `animateResize`/`currentWindowSize` and uses them inside `measure()`.

## Data flow inside `useAutoResizeWindow`

Today, `measure()`:
1. Computes `total` content height (with the pin lifted, per the existing ratchet-avoidance logic).
2. Awaits `currentMonitor()`, computes the capped `height`.
3. Calls `getCurrentWindow().setSize(new LogicalSize(width, height))` once.
4. Sets `el.style.height` to the same final value, synchronously.

New flow — steps 1, 2, and 4 are **unchanged**. Step 3 becomes:

3. Read the window's current size via `currentWindowSize()`, then call `animateResize(from, { width, height }, isCancelledForThisRun)` instead of `setSize()` directly.

**Cancellation:** the hook already tracks `cancelled` (set by the effect's cleanup) and `latestRun` (bumped each `measure()` call) to guard the `currentMonitor()` await against a stale write. The same `() => cancelled || run !== latestRun` check is passed as `animateResize`'s `isCancelled` callback, so if content changes again while an animation is still in flight (a new `ResizeObserver` fire, or the effect tearing down because `enabled` flipped false), the in-flight animation stops on its next frame instead of fighting the new target — the same pattern already proven for the pill.

**DOM height sync:** `el.style.height` keeps being written synchronously to the final target, exactly as today (step 4 is unchanged) — this preserves the existing "lift the pin before reading `scrollHeight`" ratchet-avoidance logic and every DOM-height-focused test as-is. To make that value change *look* smooth rather than snapping ahead of the window frame, `App.tsx` adds `transition-[height] duration-[180ms] ease-[cubic-bezier(0.33,1,0.68,1)]` (Tailwind arbitrary-value utilities; the bezier is the standard ease-out-cubic approximation, matching `easeOutCubic`) to the root div's existing className. The browser then animates that CSS value change in lockstep with the JS-driven window resize, with no additional per-frame DOM writes needed.

## Error handling & edge cases

- **Overlapping resizes:** handled by the cancellation guard above.
- **Pill mode:** unaffected. `enabled=false` tears the whole effect down (including any in-flight animation, via the same cleanup that already sets `cancelled = true`) before any animation logic runs.
- **Height cap:** computed once per `measure()` call exactly as today; the animation's `to` target is the already-capped value, so animating never overshoots the cap.
- **Non-Tauri/test environments:** `animateResize`, moved as-is, already catches `getCurrentWindow()`/`setSize()` per-frame failures and logs rather than throwing. `currentWindowSize()` failures are caught with a fallback (the target size itself), matching the pill's existing `.catch()` pattern in `App.tsx`.
- **Reduced motion:** explicitly out of scope (see Non-goals).

## Testing

- **New `src/lib/windowAnimation.test.ts`:** first-ever dedicated coverage for `easeOutCubic` (spot-check known values) and `animateResize` (interpolates from `from` to `to` over the given duration using a manually-driven `requestAnimationFrame` stub; stops writing frames once `isCancelled()` returns true; resolves its promise in both the completed and cancelled cases).
- **`useAutoResizeWindow.test.tsx` (existing, 14 tests):** the large majority need no changes — they assert `setSize` was eventually called with the final target via `waitFor(...)`, which still holds once the (now real-time, ~180ms) animation completes, since jsdom provides a real `requestAnimationFrame`. The one exception is **"does not ratchet the height down across repeated measurements"**, which currently asserts *exactly one* `setSize` call per `measure()` invocation via `mock.calls[0]` / `mock.calls[1]` indexing — this gets reworked to assert on the *settled* (last) call per measurement instead of an exact call count, since animating now produces multiple calls per resize.
- **New hook test:** confirms that firing the `ResizeObserver` again while a previous resize's animation is still in flight cancels the earlier animation (e.g. the window doesn't overshoot to an earlier stale target).
- **`App.test.tsx`:** no changes expected — the pill-transition tests already only assert on eventual/last-call state and already tolerate `animateResize`'s Tauri calls failing harmlessly in jsdom.
