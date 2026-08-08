# Progressive Summary Generation — Design Spec

**Date:** 2026-08-08
**Status:** Approved, ready for implementation planning

## 1. Goal

Today, the Processing pill shows a single static line — `"Generating summary…"` —
for the entire duration of summarization, which can take a few minutes on longer
meetings. The backend actually already does this work in three discrete,
independently-awaited LLM passes (see §2), but none of that structure is
surfaced to the user. This feature makes summary generation visibly
progressive, Notion-meeting-notes-style: a small checklist that fills in as
each real backend stage completes, instead of one opaque spinner.

**Explicitly out of scope:** the Transcribing stage. Transcription is a single
whisper.cpp call with no comparable internal stages to surface — this feature
is scoped to summary generation only.

## 2. Current Backend Reality (why this is honest progress, not fake steps)

`generate_notes` (`crates/meeting-notes-summary/src/notes.rs`) already runs
three focused passes per transcript chunk, each a separate
`provider.complete_json(&prompt).await` call:

1. **Notes pass** — topics, summary, attendees, decisions (`required_keys: ["topics", "summary"]`)
2. **Actions pass** — action items
3. **Questions pass** — open questions

A transcript longer than the provider's word budget is split into multiple
chunks (`split_transcript`), and **all three passes run once per chunk**,
with results merged afterward (`merge_partials`). For a typical short local
meeting this is 3 real async steps; for a long meeting it's `3 × chunk_count`.

This structure already exists and already takes real, separately-measurable
time — this feature surfaces it, it does not invent it.

## 3. Presentation

**Card, not pill.** Today's Processing state is a fixed 280×64px fully-rounded
pill (shared with Recording via the `isPill` flag in `App.tsx`). A 3-4 line
checklist does not fit that shape. Processing gets its own fixed-size card,
**340×220px**, distinct from Recording's pill — `isPill` splits into two
concerns: Recording keeps the tiny pill; Processing becomes its own state,
sized once on entry and *not* wired into the app's general content-driven
`useAutoResizeWindow` system, since the checklist's content height is stable
(always the same 3 rows, plus an optional 4th chunk-progress line) rather than
organically growing/shrinking like Idle/History content does.

**Layout** (confirmed via mockup, approved 2026-08-08):

```
┌─────────────────────────────────────┐
│ GENERATING SUMMARY                   │  <- small uppercase label
│                                       │
│  ✓  Extracting topics & summary      │  <- completed: check + strikethrough + dim
│  ●  Finding action items             │  <- active: spinner + full brightness
│  ○  Checking for open questions      │  <- upcoming: hollow circle + dim
│                                       │
└─────────────────────────────────────┘
```

- **Completed step:** checkmark, strikethrough, dimmed text.
- **Active step:** spinner, full-brightness text.
- **Upcoming step:** hollow circle, dimmed text, no strikethrough.

**Multi-chunk transcripts.** When `chunk_total > 1`, a small "Part X of Y" line
appears (e.g. above the label or beside it — implementation's call on exact
placement, following the mockup's spirit). The three steps visibly reset to
hollow/upcoming at the start of each new chunk. When `chunk_total == 1` (the
common case for local meetings), this line is omitted entirely — no "Part 1 of
1" clutter.

**Completion.** On the existing `summary-complete` event, the last step flips
to checkmark; the app then proceeds through its normal existing transition out
of Processing (unchanged).

**Failure.** On the existing summarization failure path, the step that was
active when the failure occurred gets a brief error marker, then the UI falls
through to the **existing** "Summarization failed" toast/retry flow unchanged
— this feature only adds visibility into *which* step failed before that
already-built fallback takes over. No new failure-recovery mechanism is being
built.

## 4. Backend Architecture

### 4.1 Shared progress type (`meeting-notes-core`)

```rust
pub enum SummaryPass {
    NotesAndSummary,
    ActionItems,
    OpenQuestions,
}

pub struct SummaryProgress {
    pub pass: SummaryPass,
    pub chunk_index: usize, // 0-based
    pub chunk_total: usize,
}
```

Lives in `meeting-notes-core` (not `meeting-notes-summary`) since it's a
shared vocabulary type the Tauri command layer also needs, matching this
codebase's existing convention of keeping cross-crate contract types in core.

### 4.2 Threading progress through, without breaking testability

`generate_notes`, `run_summarize`, and `run_summarize_or_mark_failed` are
**deliberately Tauri-agnostic today** — their own doc comments in
`summary_commands.rs` say so explicitly, specifically so this control flow
stays unit-testable without a running Tauri app. This feature must preserve
that property.

Fix: thread an **optional progress callback closure** through the chain,
mirroring the exact pattern `crates/meeting-notes-audio/src/mic_watcher.rs`'s
`watch_mic_activity(on_external_mic_activity: impl Fn() + Send + 'static)`
already uses for the identical problem (a Tauri-agnostic crate function that
needs to notify an event upward without depending on Tauri):

```rust
pub async fn generate_notes(
    provider: &(dyn SummaryProvider + Send + Sync),
    meeting_type: MeetingType,
    transcript: &str,
    on_progress: impl Fn(SummaryProgress) + Send + Sync,
) -> Result<SummaryResult, String>
```

Call `on_progress(...)` once per pass, immediately before that pass's
`provider.complete_json(&prompt).await` call — "pass N is starting" is the
only signal needed; the frontend infers "pass N-1 just completed" from
sequence order, so no separate start/complete event pair is needed.

Only `summarize_meeting` (the `#[tauri::command]`, which has the real
`AppHandle`) supplies a real closure:

```rust
generate_notes(provider.as_ref(), meeting.meeting_type, &transcript, |progress| {
    let _ = app.emit("summary-progress", &progress);
})
```

Unit tests for `generate_notes`/`run_summarize` pass a closure that records
calls into a `Vec` (or a no-op closure) — no real Tauri app required, same as
today.

### 4.3 New Tauri event

`"summary-progress"` — payload is `SummaryProgress` (serialized). Fired zero
or more times during a `summarize_meeting` call, before the existing
`"summary-complete"` event.

## 5. Frontend Architecture

**New component:** `SummaryChecklist` (or similar name — implementer's call),
rendered inside the Processing card in place of today's static
`"Generating summary…"` line, only during `processingStatus === "summarizing"`.

**State:** derived from listening to `"summary-progress"` (StrictMode-safe
`cancelled`-guard pattern, matching this codebase's established `listen()`
convention elsewhere in `App.tsx`/`RecorderWidget.tsx`) plus the existing
`"summary-complete"` and failure-path signals RecorderWidget already consumes.
No new backend polling — purely event-driven, matching every other
async-completion signal in this app.

**Reducer shape** (implementer's call on exact typing, but conceptually):
- Track the latest `SummaryProgress` received → derives which step is
  active/completed/upcoming, and the current `chunk_index`/`chunk_total`.
- On `summary-complete`: treat as "final pass done," last step → checkmark.
- On failure: freeze the checklist with the active step marked errored, then
  hand off to the existing failure UI (toast/retry) — this component does not
  own retry logic, it just adds a transient visual, matching the pattern
  already established for the Transcribing-failure state in the same pill.

## 6. Testing

**Backend (Rust):**
- `generate_notes`/`run_summarize` unit tests asserting the exact sequence of
  `SummaryProgress` values emitted for: a single-chunk transcript (3 events),
  a multi-chunk transcript (3 × N events with correct `chunk_index`/`chunk_total`),
  and a mid-sequence failure (events fire up to the failure point, then the
  call returns `Err` — no event for the pass that failed to *complete*, only
  the one for it *starting*, which already fired).
- No new Tauri-dependent test infrastructure — the callback-closure design
  means these stay plain async Rust tests.

**Frontend (Vitest/RTL):**
- Component tests driving `SummaryChecklist`/the Processing card through a
  scripted event sequence: single-chunk full success, multi-chunk with the
  reset-per-chunk behavior, and a failure mid-sequence confirming the correct
  step shows the error marker before falling through to existing failure UI.
- Confirm the `chunk_total === 1` case never renders a "Part 1 of 1" line.

## 7. Non-Goals

- Transcription stage progress (see §1).
- Any new retry/error-recovery mechanism — failures still resolve through the
  existing, already-built toast/retry flow; this feature only adds
  *visibility* into which step was active when a failure occurred.
- Dynamic/organic window resizing for the Processing card — it's a fixed
  340×220px size, not wired into `useAutoResizeWindow`.
- Any change to the Recording pill's size or the `isPill` concept as it
  applies to Recording — only Processing gets its own new sizing category.
