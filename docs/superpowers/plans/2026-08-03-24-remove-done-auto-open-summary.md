# Remove Done State — Auto-Open Summary Externally Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan targets the REAL current codebase**, reconstructed from fragments visible in project knowledge (real `RecorderWidget.tsx` imports: `MeetingTypePicker`, `ProviderPicker`, `Waveform`, `startWindowDrag`, `useAutoResizeWindow` in `App.tsx`, the real `WidgetState`/`ProcessingStatus` types, `createNewMeeting`/`updateMeetingStatus`/`summarizeMeeting`/`onTranscriptionComplete` handlers) — **not** the earlier sandbox version from plan 20, large parts of which are already known-stale (see plan 20's own deviation notes and plan 18's supersession notice). Treat every code sample below as illustrative of *intent*, not a byte-exact diff — verify against the actual current file before applying, the same way the controller's own deviation notes did for plan 20.

**Goal:** Remove the Done state entirely. When summarization finishes, open the generated `summary.md` in the system's default handler (Notion, a markdown editor, whatever's associated with `.md` files) and return the widget to Idle — rather than showing an in-app summary screen.

**Explicitly out of scope:** Idle, Recording, and Processing are **visually untouched** by this plan — confirmed against the current real Idle layout (eyebrow label, boxed title input, Auto-detect pill, "Summarize with" provider toggle, green Start Recording button) as an unchanged reference point. This plan is pure state-machine/behavior change: three states instead of four, plus one new side effect (opening a file) on the transition that used to lead to Done.

**Trade-off, stated plainly:** removing Done also removes the in-app interactive action-item checklist, the in-app Transcript tab, and the in-app "Regenerate with other provider" action — all become external-file interactions instead (whatever the opened editor/Notion supports). No replacement UI is added anywhere for this pass — the auto-opened file itself is the only feedback that a summary was generated.

---

### Task 1: Collapse the state machine — drop "done", auto-open summary.md, return to Idle

**Files:**
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/App.tsx`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the shell/opener plugin**

```bash
cd src-tauri && cargo add tauri-plugin-opener
```

```bash
bun add @tauri-apps/plugin-opener
```

Register in `main.rs`: `.plugin(tauri_plugin_opener::init())`, and add `"opener:allow-open-path"` (or the equivalent current permission — check `tauri-plugin-opener`'s actual permission identifier for the installed version, this has changed across releases) to `capabilities/default.json`.

- [ ] **Step 2: Narrow WidgetState to drop "done"**

```tsx
// src/components/RecorderWidget.tsx
export type WidgetState = "idle" | "recording" | "processing";
```

Every place that currently branches on `state === "done"` — the entire Done-state render block, any Done-specific refs (`actionItems`, `transcriptText`, `isRegenerating`, `otherProvider()`, `handleRegenerate`, the `Tabs`/`Avatar`/`Badge`/`Separator` Done-state JSX) — gets deleted, not just unreached. Dead state branches left behind are exactly the kind of drift that caused plan 20's task-2 rewrite; don't repeat that here in the opposite direction.

- [ ] **Step 3: Open summary.md and return to idle once summarization completes**

Find wherever `summarizeMeeting(...)` currently resolves successfully (inside the `"summarizing"` branch of the processing effect) and replace the `setState("done")` (or equivalent) with:

```tsx
// src/components/RecorderWidget.tsx (inside the successful summarizeMeeting resolution)
import { openPath } from "@tauri-apps/plugin-opener";

// ... after summarizeMeeting resolves successfully and files are written ...
const dataDir = await getDataDir();
const summaryPath = `${dataDir}/meetings/${meeting.id}/summary.md`;
try {
  await openPath(summaryPath);
} catch (err) {
  // Opening externally failing shouldn't strand the user on a stuck
  // Processing pill — fall back to at least telling them where the file is.
  console.error("Failed to open summary.md externally:", err);
}
setState("idle");
```

Note: if the real backend's `summarize_meeting` command doesn't already write `summary.md` to exactly this path (`meeting_dir.join("summary.md")`, per plan 13's `notes_markdown.rs` / `write_summary_files`), adjust the path construction to match whatever the real command actually does — this is inferred from plan 13's fragments, not confirmed against the live file layout.

- [ ] **Step 4: Update App.tsx's window-sizing logic to remove Done's branch**

The real `App.tsx` (per `useAutoResizeWindow` and `PILL_SIZES`) treats Idle and Done as both using content-driven sizing, and Recording/Processing as fixed pills. With Done gone, only Idle uses content-driven sizing now — and since Idle itself is unchanged (see this plan's scope note), its sizing behavior doesn't change either, just the conditional that used to also match `"done"`. Recording and Processing keep their existing `PILL_SIZES` entries unchanged. Update whatever conditional currently checks `widgetState === "idle" || widgetState === "done"` to just `widgetState === "idle"`.

- [ ] **Step 5: Update or delete Done-specific tests**

`RecorderWidget.test.tsx` almost certainly has a `describe("RecorderWidget done state", ...)` block or similar (given the extensive test coverage already visible for other states) — delete tests asserting Done-specific rendering, and add a new test asserting that a successful `summarizeMeeting` resolution calls `openPath` with the expected path and returns `state` to `"idle"`.

- [ ] **Step 6: Manual verification**

Run: `bun run tauri dev`, complete a full recording → transcription → summarization cycle.
Expected: once summarization finishes, `summary.md` opens in the system default handler for `.md` files, and the widget window returns to Idle looking exactly as it did before starting the recording — no intermediate Done screen appears at any point, and nothing about Idle's own layout has changed.

- [ ] **Step 7: Commit**

```bash
git add src/components/RecorderWidget.tsx src/App.tsx src-tauri/Cargo.toml src-tauri/src/main.rs src-tauri/capabilities
git commit -m "feat: remove Done state, auto-open summary.md externally on completion"
```
