# Vertical Recording Pill Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan targets the REAL current codebase.** Confirmed via project knowledge: a real `PILL_SIZES` map exists in `App.tsx` (currently horizontal — `recording: { width: 224, height: 56 }`), the pill body already carries `data-tauri-drag-region` (confirmed working without any separate grip-dot affordance), and `Waveform` already has a `compact` prop for the pill's small inline visualization. Treat code samples below as illustrative of intent — verify against the actual current shape of these files before applying, same caveat as plans 24/25/27/28.

**Goal:** Rotate the Recording pill from its current horizontal layout (dot → timer → waveform → stop button, left to right) into a vertical capsule (dot → timer → waveform → stop button, top to bottom), matching the approved **A2** mockup: light theme (unchanged from the app's existing aesthetic), no drag-dot grip (the whole pill body is already the drag region, confirmed functional without a visual affordance), real gradient/shadow polish on the stop button and pill background rather than the flat treatment shipped originally.

**Explicitly scoped to Recording only.** The Processing pill (which has since gained its own real addition — a `QualityWarning` icon+tooltip not part of any plan) is not touched by this plan. If the same vertical treatment is wanted there too, that's a follow-up, not assumed here.

> **Pre-flight review (2026-08-08):** this plan's code samples were written against an imagined/simplified version of the real files. Verified corrections below, each also inlined as a `> **Deviation:**` note at its exact step:
> 1. **Task 1's JSX sample would silently delete real, shipped functionality if applied as written.** The real Recording block (`src/components/RecorderWidget.tsx:456-502`) has three things this plan's sample omits entirely: (a) `onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}` — a WebKitGTK-specific drag fallback, with its own comment explaining that bare `data-tauri-drag-region` alone is "unreliable under WebKitGTK, this project's primary platform." This plan's own Step 2 note ("dragging relies entirely on `data-tauri-drag-region`") is based on a stale understanding of the current code, not the real drag mechanism. (b) a `micOnlyWarning` conditional block (`MicOff` icon + tooltip, "System audio unavailable — recording mic only") — real, shipped functionality. (c) `disabled={busy}` on the Stop button. All three must be preserved in the restructured vertical layout.
> 2. **Task 1 Step 1's `processing: { width: 280, height: 64 }, // unchanged` is now factually wrong** — Processing is `{ width: 340, height: 220 }` as of a separate, already-merged feature (the progressive-summary-generation checklist). The *intent* ("don't touch Processing's entry") is still correct and still what this plan wants — just don't copy the literal old value from this sample over the current real one. Copy only the `recording` line; leave `processing`'s line exactly as it already stands in the real file.
> 3. **Task 2's entire Waveform code sample assumes a different, simpler rendering technique than what's actually shipped.** The plan draws filled circles (`ctx.arc(...); ctx.fill();`) with no smoothing and an inline color ternary. The real `Waveform.tsx` draws smoothed **stroked lines with round caps** (`ctx.moveTo`/`ctx.lineTo`/`ctx.stroke()`), exponentially eased per-bar via an exported `easeTowards` helper and a persistent `displayed: Float32Array`, colored via an exported `colorForIntensity(intensity, destructiveColor)` helper (not an inline ternary), where `destructiveColor` is read live every frame from the `--destructive` CSS custom property (a raw color value, never wrapped in `hsl(...)`). Task 2 is corrected below to rotate the *real* algorithm — reusing `easeTowards`/`colorForIntensity` unchanged, not reimplementing a simpler one.
> 4. **A real, plan-omitted risk: the native click-through mask is coupled to the OLD horizontal-pill geometry and will be wrong for the new vertical shape.** `src-tauri/src/commands/window_commands.rs`'s `stadium_region(size)` hardcodes `radius = height / 2.0` and rounds the LEFT/RIGHT ends — correct for a wide-and-short horizontal pill (224×56), but geometrically wrong for a narrow-and-tall vertical capsule (60×196), where the rounding needs to be on the TOP/BOTTOM ends with `radius = width / 2.0` instead. Unfixed, this ships the same class of bug a previous session's final review caught and fixed for the Processing card (see that plan's ledger). **New Task 3 below**, added with the project owner's explicit approval, generalizes `stadium_region` to handle both orientations with real tests for the new vertical shape.
> 5. **The plan's Task 2 Step 3 manual-verification note says "if it uses this component"** about the Processing pill's waveform, hedging on uncertainty — confirmed via `grep`: `Waveform` has exactly ONE production call site in the entire codebase, `RecorderWidget.tsx:489` (the very Recording-pill block this plan modifies). There is no separate Processing-pill waveform to worry about; the "no other call site regresses" concern is real in principle (the `orientation` prop must still default safely) but there is nothing else to manually check today.

---

### Task 1: Vertical PILL_SIZES + restructured layout

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/RecorderWidget.tsx`

- [ ] **Step 1: Update PILL_SIZES to a vertical shape for Recording**

> **Deviation:** only change the `recording` line. `processing`'s current real value (`{ width: 340, height: 220 }`, from an already-merged unrelated feature) must be left exactly as it already stands in `src/App.tsx` — do not paste the `processing: { width: 280, height: 64 }` line from this sample over it, that value is stale.

```tsx
// src/App.tsx (modify only the `recording` line of PILL_SIZES; leave the
// `processing` line and its comment exactly as they currently stand)
const PILL_SIZES: Record<"recording" | "processing", { width: number; height: number }> = {
  recording: { width: 60, height: 196 }, // was { width: 224, height: 56 }
  // ... processing: { ... } stays unchanged, whatever it currently is ...
};
```

- [ ] **Step 2: Restructure the Recording state's JSX from flex-row to flex-col**

> **Deviation:** the sample below replaces the plan's original — corrected to preserve three things the original sample silently deleted: the `startWindowDrag` WebKitGTK fallback (`onMouseDown`), the `micOnlyWarning` icon/tooltip block, and `disabled={busy}` on the Stop button. Read the real current block at `src/components/RecorderWidget.tsx:456-502` first so you're editing the actual structure, not guessing from this sample alone.

```tsx
// src/components/RecorderWidget.tsx (recording state render — full
// restructure of the pill's internal layout from flex-row to flex-col,
// preserving startWindowDrag, micOnlyWarning, and disabled={busy})
if (state === "recording") {
  return (
    <div
      data-tauri-drag-region
      // There is no title bar in the pill states, so the pill itself is the
      // only drag surface -- and data-tauri-drag-region alone is unreliable
      // under WebKitGTK, this project's primary platform. requireSelfTarget
      // keeps the fallback from swallowing presses on the Stop button.
      onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
      className="h-full w-full flex flex-col items-center justify-between rounded-full py-3 px-0 bg-gradient-to-b from-background to-muted shadow-[0_12px_32px_-8px_rgba(31,36,48,0.22),0_2px_8px_rgba(31,36,48,0.08)]"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse flex-shrink-0 shadow-[0_0_8px_rgba(229,72,77,0.55)]" />
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
      <span className="text-[11px] font-mono font-semibold text-foreground tabular-nums">{formattedTime}</span>
      <Waveform active={state === "recording"} compact orientation="vertical" />
      <Button
        variant="destructive"
        size="icon"
        onClick={handleStop}
        disabled={busy}
        aria-label="Stop Recording"
        className="h-[34px] w-[34px] rounded-full flex-shrink-0 bg-gradient-to-br from-[#FF6B6E] to-[#D93B3F] shadow-[0_4px_12px_-2px_rgba(217,59,63,0.55)]"
      >
        <Square className="h-2.5 w-2.5 fill-current" />
      </Button>
    </div>
  );
}
```

Note: no grip-dot element anywhere in this markup — per the approved A2
mockup, dragging relies on `data-tauri-drag-region` plus the existing
`startWindowDrag` WebKitGTK fallback covering the pill body, exactly as it
already does today. Confirm dragging (by grabbing anywhere on the pill,
including corners of the new taller/narrower shape) still works in Step 4
below, not just assuming it from the reasoning here.

- [ ] **Step 3: Confirm the stop button's className overrides don't fight shadcn's own Button styles**

The gradient/shadow classes above are layered on top of `variant="destructive"`, not replacing it — `Button`'s own destructive background/hover/focus-ring behavior should still apply underneath, with the gradient as a visual override. If the gradient doesn't render (Tailwind's `bg-gradient-to-br` conflicting with `variant="destructive"`'s own `bg-destructive` at the same specificity), check class order/specificity rather than assuming the approach is wrong outright — this is a common Tailwind override gotcha, not necessarily a sign this needs a bigger rework.

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`, start a recording.
Expected: the window resizes to a narrow (60px) tall (196px) vertical capsule. Confirm dragging by grabbing anywhere on the pill body still works with no visual grip present. Confirm the stop button is still independently clickable (not swallowed by the drag region) — this was already true before this plan and should remain true, but re-verify rather than assume the restructure didn't change it.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/RecorderWidget.tsx
git commit -m "feat: redesign Recording pill as a vertical capsule, matching approved A2 mockup"
```

---

### Task 2: Test coverage and cleanup for Waveform's vertical rotation

> **Rewritten post-Task-1 (2026-08-09).** This task's original scope (add an `orientation` prop to `Waveform`, rotate the draw loop) is now **redundant** — Task 1's own prescribed JSX already passed `orientation="vertical"` to `Waveform`, which meant Task 1 could not type-check without that prop existing, so Task 1's implementer correctly added it there instead of shipping a temporarily-broken/overflowing waveform. The shipped rotation (`crossAxis`/`mainAxis`/`barSpacing`/`center`/`barLength`/`pos`/`vertical` naming, reusing `easeTowards`/`colorForIntensity` unchanged) was independently hand-traced by the Task 1 reviewer and confirmed correct. **Do not re-implement rotation from scratch or rename the shipped variables to match this plan's original `barExtent`/`available`/`stackPos` naming** — that would be pure churn against already-reviewed, working code. This task's real remaining scope, per the Task 1 review's findings, is: (1) add the test coverage that review found missing for the new vertical draw path, (2) add `orientation` to the `useEffect` dependency array, (3) confirm the compact-only restriction on vertical support is adequately documented (it already is, as of Task 1 — verify this, no code change expected).

**Files:**
- Modify: `src/components/Waveform.tsx`
- Modify: `src/components/Waveform.test.tsx`

**Interfaces:**
- Consumes: `Waveform`'s current real props/behavior as shipped by Task 1 (`orientation?: "horizontal" | "vertical"`, `vertical = compact && orientation === "vertical"`). Read `src/components/Waveform.tsx` in full before starting — this task builds on Task 1's actual committed code, not this plan's original (now-superseded) samples above.

- [ ] **Step 1: Write a failing test for the vertical draw path**

Read `src/components/Waveform.test.tsx`'s existing `describe("Waveform draw loop", ...)` block in full first — it already has a complete mock harness (fake 2D context, fake `AudioContext`/analyser, `FREQUENCY_BIN_COUNT = 4`, every sample maxed at 255) that the new test below reuses as-is, inside the same `describe` block, after the existing `"draws one bar per frequency bin..."` test.

```tsx
// src/components/Waveform.test.tsx (addition, inside the existing
// describe("Waveform draw loop", ...) block, same file/mock setup)
it("rotates bars to stack vertically and extend horizontally when orientation is vertical", async () => {
  render(<Waveform active compact orientation="vertical" />);

  await vi.waitFor(() => expect(ctx.stroke).toHaveBeenCalled());
  expect(ctx.stroke).toHaveBeenCalledTimes(FREQUENCY_BIN_COUNT);

  // Compact+vertical canvas is 20 wide, 90 tall (Task 1's swapped
  // dimensions) -- confirm the DOM attributes reflect that, not the
  // horizontal 90x20.
  const canvas = document.querySelector("canvas");
  expect(canvas).toHaveAttribute("width", "20");
  expect(canvas).toHaveAttribute("height", "90");

  // With FREQUENCY_BIN_COUNT=4 and canvas 20x90: barSpacing = 90/4 = 22.5,
  // so the 4 bars' stacking position (the Y argument, since bars stack
  // along the height axis when vertical) lands at 11.25, 33.75, 56.25,
  // 78.75 -- each call's moveTo/lineTo Y must differ from the next by
  // ~22.5, proving bars actually stack top-to-bottom rather than all
  // landing on one row (which unrotated/horizontal-path bars would do,
  // since horizontal keeps Y pinned at centerY for every bar).
  const moveToYPositions = ctx.moveTo.mock.calls.map((call) => call[1] as number);
  expect(moveToYPositions[0]).toBeCloseTo(11.25, 1);
  expect(moveToYPositions[1]).toBeCloseTo(33.75, 1);
  expect(moveToYPositions[2]).toBeCloseTo(56.25, 1);
  expect(moveToYPositions[3]).toBeCloseTo(78.75, 1);

  // Each bar's X (the amplitude/length axis when vertical) must be
  // centered around canvas.width / 2 = 10, not stacked along X the way
  // horizontal bars would be -- moveTo and lineTo for the same bar are
  // symmetric around that center.
  const [moveX0] = ctx.moveTo.mock.calls[0] as [number, number];
  const [lineX0] = ctx.lineTo.mock.calls[0] as [number, number];
  expect(moveX0 + lineX0).toBeCloseTo(20, 1); // symmetric around center=10 → sum is 2*10
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/numericlabs/data/rocket/meeting-notes/.claude/worktrees/vertical-recording-pill && bun run test --run Waveform 2>&1 | tail -60`
Expected: FAIL if `orientation="vertical"` isn't wired the way this test assumes, or PASS immediately if Task 1's implementation already satisfies it exactly as-is. **Either outcome is informative and acceptable** — if it passes immediately, that's strong additional confirmation Task 1's rotation is correct (the point of this step per usual TDD practice is to prove the test isn't vacuously true, so if it passes on the first run, deliberately break one line of the vertical branch in `Waveform.tsx` temporarily, confirm the test now fails, then revert — a variant of "red-green" for a case where the implementation already exists).

- [ ] **Step 3: Add `orientation` to the `useEffect` dependency array**

In `src/components/Waveform.tsx`, find the effect's closing dependency array — currently `}, [active, fftSize, minBarHeight]);` — change to `}, [active, fftSize, minBarHeight, orientation]);`. This wasn't wrong to omit given the single current call site's `orientation` prop is static (never changes after mount), but including it is the technically-correct dependency list per React's own rules, and costs nothing since `Waveform`'s effect already returns a full cleanup/re-setup on every dependency change.

- [ ] **Step 4: Confirm the compact-only restriction is documented (verification only, no code change expected)**

Read the `orientation` field's doc comment on `WaveformProps` in `src/components/Waveform.tsx`. It should already say something equivalent to "only meaningful together with `compact`; the full-size waveform never appears in a vertical layout, so it ignores this prop" (Task 1 added this). If it's missing or unclear, add/clarify it — but expect this step to be a no-op confirmation, not new work.

- [ ] **Step 5: Run tests to verify everything passes**

Run: `cd /home/numericlabs/data/rocket/meeting-notes/.claude/worktrees/vertical-recording-pill && bun run test --run 2>&1 | tail -80` (full suite, not just `Waveform` — confirm nothing else regressed) and `bun run build 2>&1 | tail -60` (clean).

- [ ] **Step 6: Manual verification**

This implementation sandbox has no display server, so `bun run tauri dev` cannot be run here — note that explicitly rather than claiming it was done. On a real desktop: start a recording, speak at varying volume, confirm the vertical pill's waveform shows bars stacked in a column with the same smoothed easing and gray → amber → red color progression as the horizontal waveform elsewhere in the app.

- [ ] **Step 7: Commit**

```bash
git add src/components/Waveform.tsx src/components/Waveform.test.tsx
git commit -m "test: add coverage for Waveform's vertical rotation, fix useEffect deps"
```

---

### Task 3: Generalize the native click-through mask for a vertical stadium

> **Added during pre-flight review (2026-08-08), approved by the project owner.** Not in the plan's original scope, but required: `src-tauri/src/commands/window_commands.rs`'s `stadium_region(size)` hardcodes `radius = height / 2.0` and rounds the LEFT/RIGHT ends of the shape -- correct for the current 224x56 horizontal Recording pill, wrong for the new 60x196 vertical capsule this plan creates, which needs the TOP/BOTTOM ends rounded instead, with `radius = width / 2.0`. Read the full current `src-tauri/src/commands/window_commands.rs` before starting -- this task modifies `stadium_region` and its test module.

**Files:**
- Modify: `src-tauri/src/commands/window_commands.rs`

**Interfaces:**
- Consumes: nothing new from Tasks 1-2 (this is backend-only; the frontend's `App.tsx` already calls `setClickThroughTracking(true)` for Recording via its `useStadiumMask` flag, unchanged by this task).
- Produces: `stadium_region` now handles both orientations transparently -- `apply_click_through` (its only caller) needs no changes at all.

- [ ] **Step 1: Write failing tests for the vertical case**

A stadium's cap radius is always half its SHORTER dimension; which pair of ends gets rounded depends on which dimension is longer. Add a new constant and a new test group mirroring the existing `RECORDING_PILL` set's *intent*, adapted for top/bottom caps instead of left/right:

```rust
// src-tauri/src/commands/window_commands.rs (additions to `mod tests`)
const VERTICAL_RECORDING_PILL: (f64, f64) = (60.0, 196.0); // this plan's new Recording pill size; radius = width / 2.0 = 30.0

#[test]
fn vertical_contains_the_straight_middle_section() {
    // Any x should be reachable at a y in the straight vertical band
    // between the two caps (roughly radius..height-radius) -- pick x=1
    // (near the left edge) and a y comfortably inside that band.
    assert!(stadium_region(VERTICAL_RECORDING_PILL).contains_point(1, 98));
}

#[test]
fn vertical_contains_the_top_cap_center_row() {
    // The row through the top cap's own center (y = radius = 30) should
    // be reachable all the way to the horizontal edges (x near 0 and
    // x near width), since the cap's widest point is exactly there --
    // the same relationship the existing horizontal
    // contains_the_left_cap_center_row/contains_the_right_cap_center_row
    // tests check for the left/right caps, rotated 90 degrees.
    assert!(stadium_region(VERTICAL_RECORDING_PILL).contains_point(1, 30));
}

#[test]
fn vertical_contains_the_bottom_cap_center_row() {
    // Mirrors the top-cap test for the bottom cap (y = height - radius = 166).
    assert!(stadium_region(VERTICAL_RECORDING_PILL).contains_point(58, 166));
}

#[test]
fn vertical_excludes_all_four_corners() {
    let region = stadium_region(VERTICAL_RECORDING_PILL);
    assert!(!region.contains_point(0, 0));
    assert!(!region.contains_point(59, 0));
    assert!(!region.contains_point(0, 195));
    assert!(!region.contains_point(59, 195));
}

#[test]
fn vertical_excludes_points_outside_the_window_bounds() {
    let region = stadium_region(VERTICAL_RECORDING_PILL);
    assert!(!region.contains_point(-5, 10));
    assert!(!region.contains_point(70, 10));
}
```

Note: the exact pixel coordinates above follow the same left/right-cap-relationship reasoning the existing horizontal tests already use, rotated 90 degrees, but were not verified by actually running Rust code during this plan's pre-flight review (no way to execute Rust in that review pass). Treat them as a starting point, not gospel -- **run the tests in Step 2/4 below and adjust any coordinate that doesn't land where its test name says it should**, the same way you'd debug any geometry test. What must NOT change is each test's *intent* (documented in its own comment) or the requirement that all 5 pass against a correct vertical-stadium implementation once Step 3 is done.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --workspace stadium 2>&1 | tail -60`
Expected: the 5 new `vertical_*` tests FAIL (the current `stadium_region` only implements the horizontal case), while all existing `RECORDING_PILL`-based tests still PASS unchanged (confirming you haven't broken the horizontal case yet, before you've touched the implementation).

- [ ] **Step 3: Generalize `stadium_region` to handle both orientations**

Reuse the existing, proven horizontal-stadium math for the vertical case by computing it against the transposed `(height, width)` dimensions, then transposing each resulting rectangle back -- a 90-degree rotation, not a second independently-derived closed-form:

```rust
// src-tauri/src/commands/window_commands.rs (replaces the current
// stadium_region function; the doc comment above it should be updated to
// describe both orientations, not just "the same stadium geometry the
// pill's CSS renders" for a single fixed shape)

/// Builds the input-shape region matching a `rounded-full` pill of `size`,
/// one physical-pixel row at a time -- the same stadium geometry the pill's
/// CSS renders. A stadium's cap radius is always half its SHORTER
/// dimension; which pair of ends gets rounded depends on which dimension is
/// longer: wider-than-tall rounds the left/right ends (the Recording pill's
/// original horizontal shape), taller-than-wide rounds the top/bottom ends
/// instead (the vertical shape this function now also supports). The
/// vertical case is computed by running the horizontal-stadium math against
/// the transposed (height, width) dimensions, then transposing each
/// resulting rectangle back -- reusing proven geometry via a 90-degree
/// rotation rather than deriving a second closed-form independently.
#[cfg(target_os = "linux")]
fn stadium_region(size: (f64, f64)) -> cairo::Region {
    let (width, height) = size;
    if height > width {
        let transposed_rects = horizontal_stadium_rects((height, width));
        let rects: Vec<cairo::RectangleInt> = transposed_rects
            .into_iter()
            .map(|r| cairo::RectangleInt::new(r.y(), r.x(), r.height(), r.width()))
            .collect();
        cairo::Region::create_rectangles(&rects)
    } else {
        cairo::Region::create_rectangles(&horizontal_stadium_rects((width, height)))
    }
}

/// The original per-row stadium-rectangle computation (unchanged math),
/// factored out so `stadium_region` can share it between the horizontal
/// case and the transposed vertical case instead of duplicating it.
#[cfg(target_os = "linux")]
fn horizontal_stadium_rects(size: (f64, f64)) -> Vec<cairo::RectangleInt> {
    let (width, height) = size;
    let radius = height / 2.0;
    let row_count = height.round().max(0.0) as i32;
    (0..row_count)
        .map(|row| {
            let y = row as f64 + 0.5;
            let dy = y - radius;
            let (left, right) = if dy.abs() >= radius {
                (radius, radius)
            } else {
                let dx = (radius * radius - dy * dy).sqrt();
                (radius - dx, width - radius + dx)
            };
            let left = left.floor().max(0.0) as i32;
            let right = right.ceil().min(width) as i32;
            cairo::RectangleInt::new(left, row, (right - left).max(0), 1)
        })
        .collect()
}
```

`cairo::RectangleInt::x()`/`.y()`/`.width()`/`.height()` above are written as method-call accessors -- **verify this against the real `cairo` crate's actual `RectangleInt` API** (check the vendored source under `~/.cargo/registry/src/.../cairo-*/`, or just try compiling and let `rustc`'s error message tell you the real accessor names/syntax if these aren't it -- could be public fields `.x`/`.y` instead of methods, depending on the crate version this workspace pins). Adjust the transpose-mapping line accordingly; the geometric logic (swap x with y, width with height) is what matters, not the exact Rust syntax written here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --workspace stadium 2>&1 | tail -60`
Expected: PASS -- all 5 new vertical tests, AND all pre-existing horizontal `RECORDING_PILL` tests (regression check: the horizontal case must produce byte-identical results to before, since `horizontal_stadium_rects` is the exact same math, just factored out).

- [ ] **Step 5: Full verification**

Run: `cd src-tauri && cargo build 2>&1 | tail -40` (clean) and `cargo test --workspace 2>&1 | tail -60` (all green, not just the `stadium`-filtered subset).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/window_commands.rs
git commit -m "fix: generalize stadium_region to support a vertical (top/bottom-capped) stadium shape"
```
