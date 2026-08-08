# Progressive Summary Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design doc:** `docs/superpowers/specs/2026-08-08-progressive-summary-generation-design.md` — read this first for the full rationale (why the checklist is honest progress not fake animation, the presentation mockup, multi-chunk/error handling decisions).

**Goal:** Replace the static "Generating summary…" text in the Processing pill with a live checklist that fills in as each of `generate_notes`'s three real backend passes (topics/summary, action items, open questions) completes.

**Architecture:** Thread an optional progress callback closure through the existing Tauri-agnostic `generate_notes`/`run_summarize`/`run_summarize_or_mark_failed` call chain (mirroring `mic_watcher.rs`'s existing `watch_mic_activity(on_external_mic_activity: impl Fn())` pattern), fired once per pass. Only `summarize_meeting` (which owns the real `AppHandle`) turns that into a `"summary-progress"` Tauri event. The frontend gets a new `SummaryChecklist` component driven by that event, replacing today's static text inside a resized Processing card.

**Tech Stack:** Rust (Tauri v2 commands, `meeting-notes-core`/`meeting-notes-summary` crates), React 19 + TypeScript, Vitest + React Testing Library.

## Global Constraints

- Scope is summary generation only — the Transcribing sub-status of Processing is unchanged (per design spec §1).
- `generate_notes`/`run_summarize`/`run_summarize_or_mark_failed` must stay Tauri-agnostic and unit-testable without a running Tauri app — this is an existing, explicit property documented in their own doc comments and must not regress.
- The checklist's 3 step labels, in fixed order, are exactly: "Extracting topics & summary" (`SummaryPass::NotesAndSummary`), "Finding action items" (`SummaryPass::ActionItems`), "Checking for open questions" (`SummaryPass::OpenQuestions`).
- The Processing card grows to a fixed **340×220px**, `rounded-2xl` (not `rounded-full`), for the entire Processing state (both Transcribing and Summarizing sub-statuses) — not dynamically resized mid-state. This is a deliberate simplification over resizing a second time when the summarizing sub-status begins: extending the existing `PILL_SIZES`-driven resize-animation effect (`App.tsx`) to react to a sub-status change would require threading a new prop up from `RecorderWidget` to `App.tsx` (which currently only knows `WidgetState`, not `ProcessingStatus`) for a purely cosmetic win (Transcribing spends only a few seconds in a slightly-too-tall card). Not worth the added coupling.
- This implementation sandbox has no display server — any step calling for manual `bun run tauri dev` verification cannot be performed here. Verify via `cargo test`, `cargo build`, `bun run test --run`, and `bun run build` only, and say so explicitly rather than claiming visual verification happened.

---

### Task 1: Backend progress types and `generate_notes` threading

**Files:**
- Modify: `crates/meeting-notes-core/src/summary.rs`
- Modify: `crates/meeting-notes-summary/src/notes.rs`
- Modify: `crates/meeting-notes-summary/src/notes_tests.rs`

**Interfaces:**
- Produces: `meeting_notes_core::summary::SummaryPass` (enum: `NotesAndSummary`, `ActionItems`, `OpenQuestions`), `meeting_notes_core::summary::SummaryProgress` (struct: `pass: SummaryPass`, `chunk_index: usize`, `chunk_total: usize`), and `generate_notes`'s new 4th parameter `on_progress: impl Fn(SummaryProgress) + Send + Sync` — Task 2 consumes both.

- [ ] **Step 1: Write failing tests for progress reporting in `generate_notes`**

Add to `crates/meeting-notes-summary/src/notes_tests.rs`, after the existing `chunks_a_long_transcript_and_runs_every_pass_per_chunk` test (this new code references `SummaryPass`/`SummaryProgress`, which don't exist yet):

```rust
// crates/meeting-notes-summary/src/notes_tests.rs (additions)
use meeting_notes_core::summary::{SummaryPass, SummaryProgress};

#[tokio::test]
async fn reports_progress_for_each_pass_in_order() {
    let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
    let progress: Mutex<Vec<SummaryProgress>> = Mutex::new(Vec::new());
    generate_notes(&provider, MeetingType::AutoDetect, "one two three", |p| {
        progress.lock().unwrap().push(p);
    })
    .await
    .expect("generate");

    let recorded = progress.into_inner().unwrap();
    assert_eq!(
        recorded,
        vec![
            SummaryProgress { pass: SummaryPass::NotesAndSummary, chunk_index: 0, chunk_total: 1 },
            SummaryProgress { pass: SummaryPass::ActionItems, chunk_index: 0, chunk_total: 1 },
            SummaryProgress { pass: SummaryPass::OpenQuestions, chunk_index: 0, chunk_total: 1 },
        ]
    );
}

#[tokio::test]
async fn reports_progress_for_each_chunk_when_transcript_is_split() {
    // Same setup as chunks_a_long_transcript_and_runs_every_pass_per_chunk:
    // budget of 2 words against a 6-word transcript gives 3 chunks.
    let responses = vec![
        PASS_A, PASS_B, PASS_C, PASS_A, PASS_B, PASS_C, PASS_A, PASS_B, PASS_C,
    ];
    let provider = ScriptedProvider::new(responses, 2);
    let progress: Mutex<Vec<SummaryProgress>> = Mutex::new(Vec::new());
    generate_notes(&provider, MeetingType::AutoDetect, "one two three four five six", |p| {
        progress.lock().unwrap().push(p);
    })
    .await
    .expect("generate");

    let recorded = progress.into_inner().unwrap();
    assert_eq!(recorded.len(), 9);
    for event in &recorded {
        assert_eq!(event.chunk_total, 3);
    }
    assert_eq!(
        recorded[0],
        SummaryProgress { pass: SummaryPass::NotesAndSummary, chunk_index: 0, chunk_total: 3 }
    );
    assert_eq!(
        recorded[3],
        SummaryProgress { pass: SummaryPass::NotesAndSummary, chunk_index: 1, chunk_total: 3 }
    );
    assert_eq!(
        recorded[6],
        SummaryProgress { pass: SummaryPass::NotesAndSummary, chunk_index: 2, chunk_total: 3 }
    );
}

#[tokio::test]
async fn stops_reporting_after_the_pass_that_failed() {
    let progress: Mutex<Vec<SummaryProgress>> = Mutex::new(Vec::new());
    let result = generate_notes(&FailingProvider, MeetingType::AutoDetect, "a transcript", |p| {
        progress.lock().unwrap().push(p);
    })
    .await;

    assert!(result.is_err());
    let recorded = progress.into_inner().unwrap();
    assert_eq!(
        recorded,
        vec![SummaryProgress { pass: SummaryPass::NotesAndSummary, chunk_index: 0, chunk_total: 1 }]
    );
}
```

Now update every existing call to `generate_notes` in this same file to pass a no-op `|_| {}` as the new 4th argument — the file currently has 9 call sites, all currently ending `.await` (some also chaining `.expect("generate")` or `.unwrap_or_else(...)` right after). Change each **exactly** as follows (old → new):

```rust
// line 69
- let result = generate_notes(&provider, MeetingType::AutoDetect, "a short transcript").await.expect("generate");
+ let result = generate_notes(&provider, MeetingType::AutoDetect, "a short transcript", |_| {}).await.expect("generate");

// line 81
- generate_notes(&provider, MeetingType::AutoDetect, "one two three").await.expect("generate");
+ generate_notes(&provider, MeetingType::AutoDetect, "one two three", |_| {}).await.expect("generate");

// line 88
- generate_notes(&provider, MeetingType::AutoDetect, "the distinctive transcript body").await.expect("generate");
+ generate_notes(&provider, MeetingType::AutoDetect, "the distinctive transcript body", |_| {}).await.expect("generate");

// line 105 (the pre-existing chunking test, NOT the new one added above)
- let result = generate_notes(&provider, MeetingType::AutoDetect, "one two three four five six").await.expect("generate");
+ let result = generate_notes(&provider, MeetingType::AutoDetect, "one two three four five six", |_| {}).await.expect("generate");

// line 117
- let result = generate_notes(&FailingProvider, MeetingType::AutoDetect, "a transcript").await;
+ let result = generate_notes(&FailingProvider, MeetingType::AutoDetect, "a transcript", |_| {}).await;

// line 125
- let result = generate_notes(&provider, MeetingType::AutoDetect, "   ").await;
+ let result = generate_notes(&provider, MeetingType::AutoDetect, "   ", |_| {}).await;

// line 135 (inside a `for meeting_type in ALL_TYPES` loop)
- generate_notes(&provider, meeting_type, "a transcript").await.expect("generate");
+ generate_notes(&provider, meeting_type, "a transcript", |_| {}).await.expect("generate");

// line 154 (a different loop, same call shape)
- generate_notes(&provider, meeting_type, "a transcript").await.expect("generate");
+ generate_notes(&provider, meeting_type, "a transcript", |_| {}).await.expect("generate");

// lines 170-172 (multi-line call)
- let result = generate_notes(&provider, meeting_type, "a transcript")
-     .await
-     .unwrap_or_else(|e| panic!("{meeting_type:?} rejected the standard shape: {e}"));
+ let result = generate_notes(&provider, meeting_type, "a transcript", |_| {})
+     .await
+     .unwrap_or_else(|e| panic!("{meeting_type:?} rejected the standard shape: {e}"));
```

- [ ] **Step 2: Run tests to verify the new ones fail and the file doesn't compile yet**

Run: `cd src-tauri && cargo test -p meeting-notes-summary 2>&1 | tail -40`
Expected: FAIL to compile — `SummaryPass`/`SummaryProgress` don't exist yet, and `generate_notes` doesn't accept a 4th argument yet.

- [ ] **Step 3: Add `SummaryPass` and `SummaryProgress` to core**

Append to `crates/meeting-notes-core/src/summary.rs` (this file already has `use serde::{Deserialize, Serialize};` at the top, so no new import is needed):

```rust
// crates/meeting-notes-core/src/summary.rs (additions, at the end of the file)

/// Identifies which of `generate_notes`'s three generation passes is
/// running, so progress can be reported to the frontend as real backend
/// work rather than a synthetic animation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SummaryPass {
    NotesAndSummary,
    ActionItems,
    OpenQuestions,
}

/// One progress notification: which pass is starting, and where it sits in
/// the current transcript chunk sequence. Fired once per pass, immediately
/// before that pass's LLM call -- "pass N starting" is the only signal the
/// frontend needs, since it implies "pass N-1 just finished."
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryProgress {
    pub pass: SummaryPass,
    /// 0-based index of the transcript chunk this pass is running against.
    pub chunk_index: usize,
    /// Total number of transcript chunks for this summarize run.
    pub chunk_total: usize,
}
```

- [ ] **Step 4: Thread `on_progress` through `generate_notes`**

In `crates/meeting-notes-summary/src/notes.rs`:

Change the import line near the top from:
```rust
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
```
to:
```rust
use meeting_notes_core::summary::{SummaryPass, SummaryProgress, SummaryProvider, SummaryResult};
```

Change the `Pass` struct (currently `prompt`/`required_keys` only) to also carry which `SummaryPass` it represents:
```rust
struct Pass<'a> {
    tag: SummaryPass,
    prompt: &'a str,
    required_keys: &'static [&'static str],
}
```

Replace the whole `generate_notes` function body with:
```rust
pub async fn generate_notes(
    provider: &(dyn SummaryProvider + Send + Sync),
    meeting_type: MeetingType,
    transcript: &str,
    on_progress: impl Fn(SummaryProgress) + Send + Sync,
) -> Result<SummaryResult, String> {
    let notes_prompt = notes_pass_for(meeting_type);
    let passes = [
        // The notes pass owns several fields; requiring topics and summary is
        // enough to catch a response shaped for a different prompt without
        // demanding every field (e.g. decisions is legitimately often empty).
        Pass {
            tag: SummaryPass::NotesAndSummary,
            prompt: notes_prompt.as_str(),
            required_keys: &["topics", "summary"],
        },
        Pass { tag: SummaryPass::ActionItems, prompt: PASS_ACTIONS, required_keys: &["action_items"] },
        Pass { tag: SummaryPass::OpenQuestions, prompt: PASS_QUESTIONS, required_keys: &["open_questions"] },
    ];

    let chunks = split_transcript(transcript, provider.input_budget_words());
    if chunks.is_empty() {
        return Err("transcript is empty, nothing to summarize".to_string());
    }
    let chunk_total = chunks.len();

    let mut fragments = Vec::new();
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        for pass in &passes {
            on_progress(SummaryProgress { pass: pass.tag, chunk_index, chunk_total });
            let prompt = format!("{}\n\n{TRANSCRIPT_CAVEAT}\n\nTranscript:\n{chunk}", pass.prompt);
            let raw = provider.complete_json(&prompt).await?;
            fragments.push(parse_pass_fragment(&raw, pass.required_keys)?);
        }
    }

    Ok(merge_partials(fragments))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test -p meeting-notes-summary 2>&1 | tail -60`
Expected: PASS — all 3 new tests, plus every pre-existing test in this crate (they now compile with the `|_| {}` no-op closure added).

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-core/src/summary.rs crates/meeting-notes-summary/src/notes.rs crates/meeting-notes-summary/src/notes_tests.rs
git commit -m "feat: report per-pass progress from generate_notes"
```

---

### Task 2: Thread progress through the Tauri command layer

**Files:**
- Modify: `src-tauri/src/commands/summary_commands.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `SummaryPass`, `SummaryProgress`, and `generate_notes`'s new signature from Task 1.
- Produces: a new Tauri event `"summary-progress"` (payload: `SummaryProgress`, serialized), emitted zero or more times by `summarize_meeting` before its existing `"summary-complete"` event. Task 3 (frontend) consumes this event name and payload shape.

- [ ] **Step 1: Add a dev-dependency needed for this task's test**

In `src-tauri/Cargo.toml`, find the existing `[dev-dependencies]` section:
```toml
[dev-dependencies]
hound = "3.5.1"
```
Change it to:
```toml
[dev-dependencies]
hound = "3.5.1"
async-trait = "0.1.91"
```
(This crate's own test module needs to implement the `#[async_trait] SummaryProvider` trait with a stub provider in Step 4 below — `async-trait` is already a dependency of `meeting-notes-core`, where the trait is defined, but implementing a trait that uses `#[async_trait]` also requires the macro to be in scope at the impl site.)

- [ ] **Step 2: Write the failing test for progress threading through `run_summarize`**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/commands/summary_commands.rs`, after the existing `run_summarize_or_mark_failed_marks_the_meeting_failed_in_the_index_on_error` test:

```rust
// src-tauri/src/commands/summary_commands.rs (additions inside `mod tests`)
#[tokio::test]
async fn run_summarize_calls_on_progress_for_each_pass() {
    use meeting_notes_core::summary::{SummaryPass, SummaryProgress};
    use std::sync::Mutex;

    struct StubProvider;
    #[async_trait::async_trait]
    impl SummaryProvider for StubProvider {
        fn input_budget_words(&self) -> usize {
            1000
        }
        async fn complete_json(&self, _prompt: &str) -> Result<String, String> {
            Ok(r#"{"meeting_type":"Sync","attendees":[],"referenced_people":[],"summary":"s",
"topics":[],"decisions":[],"action_items":[],"open_questions":[]}"#
                .to_string())
        }
    }

    let base = temp_base("run-summarize-progress");
    let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
    append_to_index(&base, &meeting).expect("append to index");
    std::fs::write(meeting.dir_path(&base).join("transcript.txt"), "hello there")
        .expect("write transcript");

    let progress: Mutex<Vec<SummaryProgress>> = Mutex::new(Vec::new());
    let result = run_summarize(&base, meeting, Box::new(StubProvider), |p| {
        progress.lock().unwrap().push(p);
    })
    .await;

    assert!(result.is_ok(), "expected success, got {result:?}");
    let recorded = progress.into_inner().unwrap();
    assert_eq!(
        recorded,
        vec![
            SummaryProgress { pass: SummaryPass::NotesAndSummary, chunk_index: 0, chunk_total: 1 },
            SummaryProgress { pass: SummaryPass::ActionItems, chunk_index: 0, chunk_total: 1 },
            SummaryProgress { pass: SummaryPass::OpenQuestions, chunk_index: 0, chunk_total: 1 },
        ]
    );

    std::fs::remove_dir_all(&base).ok();
}
```

Also update the existing `run_summarize_or_mark_failed_marks_the_meeting_failed_in_the_index_on_error` test's call site — it currently calls `run_summarize_or_mark_failed` with 3 arguments:
```rust
let result = tauri::async_runtime::block_on(run_summarize_or_mark_failed(
    &base,
    meeting.clone(),
    Box::new(ClaudeProvider::new("dummy-api-key".to_string())),
));
```
Add a no-op 4th argument:
```rust
let result = tauri::async_runtime::block_on(run_summarize_or_mark_failed(
    &base,
    meeting.clone(),
    Box::new(ClaudeProvider::new("dummy-api-key".to_string())),
    |_progress| {},
));
```

- [ ] **Step 3: Run tests to verify they fail to compile**

Run: `cd src-tauri && cargo test -p meeting-notes-lib summarize 2>&1 | tail -40`
Expected: FAIL to compile — `run_summarize`/`run_summarize_or_mark_failed` don't accept a 4th argument yet.

- [ ] **Step 4: Thread `on_progress` through `run_summarize`, `run_summarize_or_mark_failed`, and `summarize_meeting`**

In `src-tauri/src/commands/summary_commands.rs`, change the import line near the top from:
```rust
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
```
to:
```rust
use meeting_notes_core::summary::{SummaryProgress, SummaryProvider, SummaryResult};
```

Replace `run_summarize` with:
```rust
async fn run_summarize(
    base: &Path,
    meeting: MeetingMeta,
    provider: Box<dyn SummaryProvider + Send + Sync>,
    on_progress: impl Fn(SummaryProgress) + Send + Sync,
) -> Result<(SummaryResult, MeetingMeta), String> {
    let meeting_dir = meeting.dir_path(base);
    let transcript = std::fs::read_to_string(meeting_dir.join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))?;

    let result = generate_notes(provider.as_ref(), meeting.meeting_type, &transcript, on_progress).await?;

    write_summary_files(&meeting_dir, &result, &meeting)?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Done;
    update_meeting(base, &updated).map_err(|e| e.to_string())?;

    Ok((result, updated))
}
```

Replace `run_summarize_or_mark_failed` with:
```rust
async fn run_summarize_or_mark_failed(
    base: &Path,
    meeting: MeetingMeta,
    provider: Box<dyn SummaryProvider + Send + Sync>,
    on_progress: impl Fn(SummaryProgress) + Send + Sync,
) -> Result<(SummaryResult, MeetingMeta), String> {
    match run_summarize(base, meeting.clone(), provider, on_progress).await {
        Ok(ok) => Ok(ok),
        Err(e) => {
            mark_meeting_failed(base, meeting, &e);
            Err(e)
        }
    }
}
```

In `summarize_meeting`, find this line:
```rust
    let (result, updated) = run_summarize_or_mark_failed(&base, meeting, provider).await?;
```
Replace it with (this clones `app` before moving it into the closure, since `app` is still needed afterward for the existing `"summary-complete"` emit — the exact same clone-then-move pattern `mic_watcher_commands.rs`'s `start_mic_watcher` already uses):
```rust
    let app_for_progress = app.clone();
    let (result, updated) = run_summarize_or_mark_failed(&base, meeting, provider, move |progress| {
        let _ = app_for_progress.emit("summary-progress", &progress);
    })
    .await?;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo build 2>&1 | tail -40` (must be clean), then `cargo test --workspace 2>&1 | tail -40` (all green, including the 4 tests touched/added in this task and Task 1).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/summary_commands.rs src-tauri/Cargo.toml Cargo.lock
git commit -m "feat: emit summary-progress events from summarize_meeting"
```

---

### Task 3: Frontend event wrapper and types

**Files:**
- Modify: `src/lib/summary.ts`

**Interfaces:**
- Produces: `SummaryPass` (TS union type mirroring the Rust enum, serialized as PascalCase strings — `"NotesAndSummary" | "ActionItems" | "OpenQuestions"`), `SummaryProgress` (TS interface: `{ pass: SummaryPass; chunk_index: number; chunk_total: number }`), and `onSummaryProgress(callback)` — Task 5 (RecorderWidget) consumes all three.

- [ ] **Step 1: Add the event wrapper and types**

In `src/lib/summary.ts`, add `listen` to the existing import line — currently:
```typescript
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/lib/config";
```
change to:
```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppConfig } from "@/lib/config";
```

Add the following after the existing `ProviderKind` type declaration (`export type ProviderKind = "Claude" | "Ollama";`):
```typescript
// Mirrors meeting_notes_core::summary::SummaryPass -- a plain Rust enum
// serializes as its variant name verbatim (PascalCase, no rename), matching
// how ProviderKind above already mirrors its Rust counterpart the same way.
export type SummaryPass = "NotesAndSummary" | "ActionItems" | "OpenQuestions";

// Mirrors meeting_notes_core::summary::SummaryProgress.
export interface SummaryProgress {
  pass: SummaryPass;
  chunk_index: number;
  chunk_total: number;
}

// Fired once per generate_notes pass (see crates/meeting-notes-summary/src/notes.rs),
// immediately before that pass's LLM call. Mirrors onTranscriptionComplete's
// shape in src/lib/transcription.ts.
export const onSummaryProgress = (callback: (progress: SummaryProgress) => void) =>
  listen<SummaryProgress>("summary-progress", (event) => callback(event.payload));
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run build 2>&1 | tail -40`
Expected: PASS (tsc + vite build clean) — this task adds no new call sites yet, so there's nothing to unit-test in isolation; Task 4 and Task 5 exercise this module.

- [ ] **Step 3: Commit**

```bash
git add src/lib/summary.ts
git commit -m "feat: add onSummaryProgress event wrapper and SummaryProgress types"
```

---

### Task 4: `SummaryChecklist` component

**Files:**
- Create: `src/components/SummaryChecklist.tsx`
- Create: `src/components/SummaryChecklist.test.tsx`

**Interfaces:**
- Consumes: `SummaryPass` from `src/lib/summary.ts` (Task 3).
- Produces: `SummaryChecklist` component with props `{ currentStep: SummaryPass | "complete" | null; failed?: boolean; chunkIndex: number; chunkTotal: number }` — Task 5 (RecorderWidget) renders this.

- [ ] **Step 1: Write the failing component tests**

```tsx
// src/components/SummaryChecklist.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SummaryChecklist } from "@/components/SummaryChecklist";

describe("SummaryChecklist", () => {
  it("renders all three step labels", () => {
    render(<SummaryChecklist currentStep={null} chunkIndex={0} chunkTotal={1} />);
    expect(screen.getByText("Extracting topics & summary")).toBeInTheDocument();
    expect(screen.getByText("Finding action items")).toBeInTheDocument();
    expect(screen.getByText("Checking for open questions")).toBeInTheDocument();
  });

  it("shows every step as upcoming before the first progress event", () => {
    render(<SummaryChecklist currentStep={null} chunkIndex={0} chunkTotal={1} />);
    const topics = screen.getByText("Extracting topics & summary");
    expect(topics.className).not.toContain("line-through");
  });

  it("marks earlier steps complete and the current step active", () => {
    render(<SummaryChecklist currentStep="ActionItems" chunkIndex={0} chunkTotal={1} />);
    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
    expect(screen.getByText("Finding action items").className).not.toContain("line-through");
    expect(screen.getByText("Finding action items").className).not.toContain("text-muted-foreground");
    expect(screen.getByText("Checking for open questions").className).toContain("text-muted-foreground");
    expect(screen.getByText("Checking for open questions").className).not.toContain("line-through");
  });

  it("marks every step complete when currentStep is complete", () => {
    render(<SummaryChecklist currentStep="complete" chunkIndex={0} chunkTotal={1} />);
    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
    expect(screen.getByText("Finding action items").className).toContain("line-through");
    expect(screen.getByText("Checking for open questions").className).toContain("line-through");
  });

  it("marks the active step errored when failed is true", () => {
    render(<SummaryChecklist currentStep="ActionItems" failed chunkIndex={0} chunkTotal={1} />);
    const activeLabel = screen.getByText("Finding action items");
    expect(activeLabel.className).toContain("text-red-600");
    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
  });

  it("omits the chunk-progress line when there is only one chunk", () => {
    render(<SummaryChecklist currentStep="ActionItems" chunkIndex={0} chunkTotal={1} />);
    expect(screen.queryByText(/part \d+ of \d+/i)).not.toBeInTheDocument();
  });

  it("shows the chunk-progress line for a multi-chunk transcript", () => {
    render(<SummaryChecklist currentStep="ActionItems" chunkIndex={1} chunkTotal={3} />);
    expect(screen.getByText("Part 2 of 3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test --run SummaryChecklist 2>&1 | tail -40`
Expected: FAIL — `@/components/SummaryChecklist` does not exist yet.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/SummaryChecklist.tsx
import { AlertTriangle, Check } from "lucide-react";
import type { SummaryPass } from "@/lib/summary";

interface SummaryChecklistProps {
  /** The pass the latest summary-progress event named, "complete" once
   *  summarize_meeting has resolved successfully, or null before the first
   *  event has arrived. */
  currentStep: SummaryPass | "complete" | null;
  /** True when summarization failed while `currentStep` was active -- that
   *  step renders with an error marker instead of a spinner. */
  failed?: boolean;
  /** 0-based index of the transcript chunk currently being processed. */
  chunkIndex: number;
  /** Total transcript chunks for this run. */
  chunkTotal: number;
}

const PASS_ORDER: SummaryPass[] = ["NotesAndSummary", "ActionItems", "OpenQuestions"];

const PASS_LABELS: Record<SummaryPass, string> = {
  NotesAndSummary: "Extracting topics & summary",
  ActionItems: "Finding action items",
  OpenQuestions: "Checking for open questions",
};

export function SummaryChecklist({ currentStep, failed = false, chunkIndex, chunkTotal }: SummaryChecklistProps) {
  const currentIndex =
    currentStep === "complete" || currentStep === null ? PASS_ORDER.length : PASS_ORDER.indexOf(currentStep);

  return (
    <div className="flex flex-col gap-2 w-full">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Generating summary</span>
      {chunkTotal > 1 && (
        <span className="text-[9px] text-muted-foreground">
          Part {chunkIndex + 1} of {chunkTotal}
        </span>
      )}
      <div className="flex flex-col gap-2">
        {PASS_ORDER.map((pass, index) => {
          const isComplete = index < currentIndex;
          const isActive = index === currentIndex && currentStep !== "complete" && currentStep !== null;
          const isErrored = isActive && failed;

          return (
            <div key={pass} className="flex items-center gap-2">
              {isErrored ? (
                <AlertTriangle className="h-3.5 w-3.5 text-red-600 flex-shrink-0" aria-hidden="true" />
              ) : isComplete ? (
                <Check className="h-3.5 w-3.5 text-green-500 flex-shrink-0" aria-hidden="true" />
              ) : isActive ? (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex-shrink-0" />
              ) : (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30 flex-shrink-0" />
              )}
              <span
                className={
                  isErrored
                    ? "text-xs text-red-600"
                    : isComplete
                      ? "text-xs text-muted-foreground line-through"
                      : isActive
                        ? "text-xs text-foreground"
                        : "text-xs text-muted-foreground"
                }
              >
                {PASS_LABELS[pass]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test --run SummaryChecklist 2>&1 | tail -40`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/SummaryChecklist.tsx src/components/SummaryChecklist.test.tsx
git commit -m "feat: add SummaryChecklist component"
```

---

### Task 5: Wire `SummaryChecklist` into `RecorderWidget`, resize the Processing card

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/components/RecorderWidget.test.tsx`

**Interfaces:**
- Consumes: `SummaryChecklist` (Task 4), `onSummaryProgress`/`SummaryProgress`/`SummaryPass` (Task 3).

- [ ] **Step 1: Resize and reshape the Processing card in `App.tsx`**

In `src/App.tsx`, find the `PILL_SIZES` table:
```typescript
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
```
Replace the `processing` entry and its comment with:
```typescript
const PILL_SIZES: Record<"recording" | "processing", { width: number; height: number }> = {
  recording: { width: 224, height: 56 },
  // Sized for the SummaryChecklist card (3 step rows + label + optional
  // chunk-progress line, see SummaryChecklist.tsx), not the compact single
  // line this pill originally held. Applies for the whole Processing state
  // -- both the Transcribing and Summarizing sub-statuses -- rather than
  // resizing a second time when the checklist actually appears, since
  // Transcribing spends only a few seconds in a slightly-too-tall card and
  // a second resize isn't worth threading ProcessingStatus up from
  // RecorderWidget into this table just for that.
  processing: { width: 340, height: 220 },
};
```

- [ ] **Step 2: Run the frontend build to confirm the sizing change alone doesn't break anything**

Run: `bun run build 2>&1 | tail -40`
Expected: PASS.

- [ ] **Step 3: Write failing tests for the checklist wiring in `RecorderWidget`**

First, in `src/components/RecorderWidget.test.tsx`, extend the existing `vi.mock("@/lib/summary", ...)` block — currently:
```typescript
vi.mock("@/lib/summary", async (importOriginal) => {
  // resolveProvider (and the toProviderKind it uses internally) are pure
  // config-resolution logic (no Tauri invoke), so the real implementation
  // is used here — only summarizeMeeting (the actual IPC call) needs
  // mocking.
  const actual = await importOriginal<typeof import("@/lib/summary")>();
  return {
    ...actual,
    summarizeMeeting: vi.fn(),
  };
});
```
Change the returned object to also mock `onSummaryProgress`:
```typescript
vi.mock("@/lib/summary", async (importOriginal) => {
  // resolveProvider (and the toProviderKind it uses internally) are pure
  // config-resolution logic (no Tauri invoke), so the real implementation
  // is used here — only summarizeMeeting and onSummaryProgress (the actual
  // IPC call and event listener) need mocking.
  const actual = await importOriginal<typeof import("@/lib/summary")>();
  return {
    ...actual,
    summarizeMeeting: vi.fn(),
    onSummaryProgress: vi.fn(),
  };
});
```

Then find the `beforeEach` block that resets `summarizeMeeting`'s mock:
```typescript
  const { summarizeMeeting } = await import("@/lib/summary");
  vi.mocked(summarizeMeeting).mockReset().mockResolvedValue({
```
Add a default reset for `onSummaryProgress` right before it, so every existing test that doesn't care about progress still gets a working no-op unlisten function (mirroring `onTranscriptionComplete`'s default reset a few lines above it):
```typescript
  const { summarizeMeeting, onSummaryProgress } = await import("@/lib/summary");
  vi.mocked(onSummaryProgress).mockReset().mockResolvedValue(() => {});
  vi.mocked(summarizeMeeting).mockReset().mockResolvedValue({
```

Now add these new tests, placed in the `describe("RecorderWidget summary failure fallback", ...)` block (after its existing two tests, before that block's closing `});`) and a new top-level block for the checklist-specific tests. First, the checklist-wiring tests — add this new `describe` block at the end of the file:

```tsx
// src/components/RecorderWidget.test.tsx (additions, new describe block at end of file)
describe("RecorderWidget summary checklist", () => {
  async function captureBothCallbacks() {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    const { onSummaryProgress } = await import("@/lib/summary");
    let fireTranscription: ((meeting: MeetingMeta) => void) | undefined;
    let fireProgress: ((progress: SummaryProgress) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fireTranscription = callback;
      return () => {};
    });
    vi.mocked(onSummaryProgress).mockImplementation(async (callback) => {
      fireProgress = callback;
      return () => {};
    });
    return {
      fireTranscription: async (meeting: MeetingMeta) => {
        await act(async () => fireTranscription!(meeting));
      },
      fireProgress: async (progress: SummaryProgress) => {
        await act(async () => fireProgress!(progress));
      },
    };
  }

  it("shows the checklist step named by the latest summary-progress event", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    vi.mocked(summarizeMeeting).mockImplementation(() => new Promise(() => {}));
    const { fireTranscription, fireProgress } = await captureBothCallbacks();

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await fireTranscription(transcribedMeeting);

    await fireProgress({ pass: "ActionItems", chunk_index: 0, chunk_total: 1 });

    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
    expect(screen.getByText("Finding action items").className).not.toContain("line-through");
  });

  it("briefly shows the failed step before returning to idle when summarization fails mid-checklist", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { summarizeMeeting } = await import("@/lib/summary");
      let rejectSummarize: ((err: Error) => void) | undefined;
      vi.mocked(summarizeMeeting).mockImplementation(
        () => new Promise((_resolve, reject) => (rejectSummarize = reject))
      );
      const { fireTranscription, fireProgress } = await captureBothCallbacks();

      render(
        <>
          <Toaster />
          <RecorderWidget />
        </>
      );
      fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
      fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
      await fireTranscription(transcribedMeeting);
      await fireProgress({ pass: "ActionItems", chunk_index: 0, chunk_total: 1 });

      await act(async () => rejectSummarize!(new Error("endpoint down")));

      // Immediately after the rejection, the checklist is still visible
      // with the active step marked errored -- the widget must not have
      // snapped back to idle yet.
      expect(screen.getByText("Finding action items").className).toContain("text-red-600");
      expect(screen.queryByRole("button", { name: /start recording/i })).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

Add the `SummaryProgress` type import at the top of the test file (line 7, immediately after the existing imports). Find:
```typescript
import type { MeetingMeta } from "@/lib/storage";
```
Add immediately after it:
```typescript
import type { SummaryProgress } from "@/lib/summary";
```

- [ ] **Step 4: Run tests to verify the new ones fail**

Run: `bun run test --run RecorderWidget 2>&1 | tail -60`
Expected: FAIL — `RecorderWidget` doesn't render a checklist yet, doesn't import `onSummaryProgress`, and the failure-delay behavior doesn't exist yet.

- [ ] **Step 5: Wire the checklist into `RecorderWidget.tsx`**

Add `SummaryChecklist` and the new summary.ts exports to the existing import block. Find:
```typescript
import { summarizeMeeting, resolveProvider, type ProviderKind } from "@/lib/summary";
```
Replace with:
```typescript
import {
  summarizeMeeting,
  resolveProvider,
  onSummaryProgress,
  type ProviderKind,
  type SummaryPass,
  type SummaryProgress,
} from "@/lib/summary";
import { SummaryChecklist } from "@/components/SummaryChecklist";
```

Add new state, alongside the existing `processingStatus` state declaration. Find:
```typescript
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>("transcribing");
```
Add immediately after it:
```typescript
  const [summaryStep, setSummaryStep] = useState<SummaryPass | "complete" | null>(null);
  const [summaryChunk, setSummaryChunk] = useState<{ index: number; total: number }>({ index: 0, total: 1 });
  const [summaryFailed, setSummaryFailed] = useState(false);
```

Add a ref alongside the existing `summarizeRunRef` declaration. Find:
```typescript
  const summarizeRunRef = useRef(0);
```
Add immediately after it:
```typescript
  // Mirrors summaryStep but readable synchronously inside runSummarization's
  // catch block without adding summaryStep to that callback's dependency
  // array (which would otherwise recreate it on every progress event).
  const summaryStepRef = useRef<SummaryPass | "complete" | null>(null);
```

Replace the whole `runSummarization` function body. Find:
```typescript
  const runSummarization = useCallback(async (meetingId: string, provider?: ProviderKind) => {
    // Claim this as the current run. If summarizeRunRef.current no longer
    // matches `run` by the time an awaited call below resolves, the widget
    // has since left the state this run belongs to (e.g. a new recording
    // started) — every set* call, including in `finally`, must then be
    // skipped so a late-arriving run cannot yank the UI back.
    const run = ++summarizeRunRef.current;
    setProcessingStatus("summarizing");
    try {
      // Called with only one argument (no explicit `undefined` forwarded)
      // when there is nothing to override, so the zero-provider path is
      // observably identical to the pre-picker call site.
      provider ? await summarizeMeeting(meetingId, provider) : await summarizeMeeting(meetingId);
      if (summarizeRunRef.current !== run) return;
      try {
        await openSummary(meetingId);
      } catch (err) {
        // Opening externally failing shouldn't strand the user on a stuck
        // Processing pill — the file is still on disk even if it couldn't
        // be opened for them.
        console.error("Failed to open summary.md externally:", errorMessage(err));
      }
    } catch (err) {
      if (summarizeRunRef.current !== run) return;
      // The transcript is already on disk, so a summary failure is not data
      // loss. There is no in-app screen to surface it on, so the widget
      // still returns to idle rather than being stuck on "Generating
      // summary…" forever -- the toast is what tells the user it happened.
      console.error("Summary generation failed:", errorMessage(err));
      toast.error(`Failed to generate summary: ${errorMessage(err)}`);
    } finally {
      if (summarizeRunRef.current === run) setState("idle");
    }
  }, []);
```

Replace it with:
```typescript
  const runSummarization = useCallback(async (meetingId: string, provider?: ProviderKind) => {
    // Claim this as the current run. If summarizeRunRef.current no longer
    // matches `run` by the time an awaited call below resolves, the widget
    // has since left the state this run belongs to (e.g. a new recording
    // started) — every set* call, including in `finally`, must then be
    // skipped so a late-arriving run cannot yank the UI back.
    const run = ++summarizeRunRef.current;
    setProcessingStatus("summarizing");
    setSummaryStep(null);
    summaryStepRef.current = null;
    setSummaryChunk({ index: 0, total: 1 });
    setSummaryFailed(false);

    let unlistenProgress: (() => void) | undefined;
    try {
      unlistenProgress = await onSummaryProgress((progress) => {
        if (summarizeRunRef.current !== run) return;
        setSummaryStep(progress.pass);
        summaryStepRef.current = progress.pass;
        setSummaryChunk({ index: progress.chunk_index, total: progress.chunk_total });
      });
      if (summarizeRunRef.current !== run) return;

      // Called with only one argument (no explicit `undefined` forwarded)
      // when there is nothing to override, so the zero-provider path is
      // observably identical to the pre-picker call site.
      provider ? await summarizeMeeting(meetingId, provider) : await summarizeMeeting(meetingId);
      if (summarizeRunRef.current !== run) return;
      setSummaryStep("complete");
      summaryStepRef.current = "complete";
      try {
        await openSummary(meetingId);
      } catch (err) {
        // Opening externally failing shouldn't strand the user on a stuck
        // Processing pill — the file is still on disk even if it couldn't
        // be opened for them.
        console.error("Failed to open summary.md externally:", errorMessage(err));
      }
    } catch (err) {
      if (summarizeRunRef.current !== run) return;
      // The transcript is already on disk, so a summary failure is not data
      // loss. The toast is what tells the user it happened either way; if
      // the checklist ever showed a step in progress, briefly mark it
      // errored before returning to idle instead of yanking the pill away
      // the instant the toast fires, so the user sees which step failed
      // rather than the checklist just vanishing mid-step.
      console.error("Summary generation failed:", errorMessage(err));
      toast.error(`Failed to generate summary: ${errorMessage(err)}`);
      if (summaryStepRef.current !== null && summaryStepRef.current !== "complete") {
        setSummaryFailed(true);
        unlistenProgress?.();
        unlistenProgress = undefined;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      unlistenProgress?.();
      if (summarizeRunRef.current === run) setState("idle");
    }
  }, []);
```

Finally, replace the entire Processing-state return block — this changes the container's shape/size classes, the `qualityWarning` comment, and turns the old two-way `transcriptionError ? (...) : (...)` into a three-way ternary that inserts the checklist. Find the complete block:
```tsx
  if (state === "processing") {
    return (
      <div
        data-tauri-drag-region
        // Same reasoning as the Recording pill above. requireSelfTarget
        // matters more here: this pill can hold a Retry button, which would
        // otherwise have its mousedown turned into a window drag on the way up.
        onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
        className="h-full w-full flex items-center justify-center gap-2 bg-background border rounded-full px-3 py-2 shadow-sm text-sm text-muted-foreground"
      >
        {qualityWarning && (
          // Fixed-size pill (280x64), so an arbitrary-length backend string
          // gets a compact icon + tooltip/accessible-label instead of a full
          // line, the same treatment as micOnlyWarning in the Recording pill.
          <span
            role="img"
            aria-label={qualityWarning}
            title={qualityWarning}
            className="flex-shrink-0 text-amber-600"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
        {transcriptionError ? (
          // The audio is always preserved on disk, so this is recoverable:
          // offer the retry rather than sending the user back to idle. The
          // underlying error sits alongside it so a missing binary or bad
          // model name is diagnosable, not just "it failed".
          <div role="alert" className="flex items-center gap-1.5 min-w-0">
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[10px] font-medium text-red-600">Transcription failed</span>
              <span className="text-[9px] text-muted-foreground truncate max-w-[130px]">
                {transcriptionError}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => runTranscription()}
              className="flex-shrink-0"
            >
              Retry
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleDismissFailure}
              className="flex-shrink-0"
            >
              Dismiss
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex-shrink-0" />
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-xs truncate">
                {processingStatus === "transcribing" ? "Transcribing…" : "Generating summary…"}
              </span>
              {processingStatus === "summarizing" && (
                // Wrapped, not truncated: this sentence is long enough that
                // ellipsis-truncating it loses real information, and wrapping
                // to 2 lines can never overflow the pill horizontally no
                // matter how the flex/min-width chain above it resolves --
                // unlike single-line truncate, which depends on every
                // ancestor computing a definite width correctly.
                <span className="text-[9px] whitespace-normal">
                  Long meetings are summarized in several passes — this may take a few minutes.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
}
```
Replace it with:
```tsx
  if (state === "processing") {
    return (
      <div
        data-tauri-drag-region
        // Same reasoning as the Recording pill above. requireSelfTarget
        // matters more here: this pill can hold a Retry button, which would
        // otherwise have its mousedown turned into a window drag on the way up.
        onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
        className="h-full w-full flex items-center justify-center gap-2 bg-background border rounded-2xl px-4 py-3 shadow-sm text-sm text-muted-foreground"
      >
        {qualityWarning && (
          // Fixed-size card (340x220), so an arbitrary-length backend string
          // gets a compact icon + tooltip/accessible-label instead of a full
          // line, the same treatment as micOnlyWarning in the Recording pill.
          <span
            role="img"
            aria-label={qualityWarning}
            title={qualityWarning}
            className="flex-shrink-0 text-amber-600"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
        {transcriptionError ? (
          // The audio is always preserved on disk, so this is recoverable:
          // offer the retry rather than sending the user back to idle. The
          // underlying error sits alongside it so a missing binary or bad
          // model name is diagnosable, not just "it failed".
          <div role="alert" className="flex items-center gap-1.5 min-w-0">
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[10px] font-medium text-red-600">Transcription failed</span>
              <span className="text-[9px] text-muted-foreground truncate max-w-[130px]">
                {transcriptionError}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => runTranscription()}
              className="flex-shrink-0"
            >
              Retry
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleDismissFailure}
              className="flex-shrink-0"
            >
              Dismiss
            </Button>
          </div>
        ) : processingStatus === "summarizing" ? (
          <SummaryChecklist
            currentStep={summaryStep}
            failed={summaryFailed}
            chunkIndex={summaryChunk.index}
            chunkTotal={summaryChunk.total}
          />
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex-shrink-0" />
            <span className="text-xs truncate">Transcribing…</span>
          </div>
        )}
      </div>
    );
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test --run RecorderWidget 2>&1 | tail -80`
Expected: PASS — every pre-existing test in this file plus the 2 new ones in Task 5's Step 3. Pay particular attention to `"switches the status to Generating summary once transcription completes"` (should still pass unchanged, since `SummaryChecklist`'s header label text is literally "Generating summary") and the two summary-failure tests (`"logs the failure and returns to idle instead of opening a file"`, `"shows an error toast when summary generation fails"`, `"still leaves the processing state when the summary fails"`) — these mock `summarizeMeeting` to reject immediately with no prior progress event, so `summaryStepRef.current` stays `null` and the new 1.5s delay must NOT trigger for them; if any of these three time out or need a fake-timer advance to pass, something is wired wrong.

- [ ] **Step 7: Full verification sweep**

Run: `cd src-tauri && cargo build 2>&1 | tail -40 && cargo test --workspace 2>&1 | tail -60`, then from the repo root: `bun run test --run 2>&1 | tail -60 && bun run build 2>&1 | tail -60`. All must be clean.

- [ ] **Step 8: Manual verification**

This implementation sandbox has no display server — `bun run tauri dev` cannot be run here. On a real desktop: start a recording, stop it, and watch the Processing card during summarization. Expected: the card grows to the new size when Processing begins; during Transcribing it shows the unchanged spinner + "Transcribing…" text (with extra empty space below, which is expected per this task's Global Constraints); once Summarizing begins, the checklist appears and its steps tick off in order as `generate_notes`'s three passes actually complete; for a meeting long enough to chunk the transcript, confirm a "Part X of Y" line appears and the three steps visibly reset per chunk. If this step cannot be performed, say so explicitly rather than claiming it was verified.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx
git commit -m "feat: replace static Generating-summary text with a live per-pass checklist"
```
