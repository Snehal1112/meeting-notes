# Summary Prompt Caching & Quality Tweaks — Design Spec

**Date:** 2026-08-12
**Status:** Approved, ready for implementation planning

## 1. Goal

Summarizing a 38-minute meeting via the Claude provider currently costs
24,285 input tokens / 13,303 output tokens. The trigger was cost, but the
scope covers both cost and a small quality improvement, since neither
requires touching the other.

**Explicitly out of scope:** consolidating the 3-pass pipeline into fewer
LLM calls. The 3-pass split (`crates/meeting-notes-summary/src/notes.rs`)
exists specifically to stop weaker models from returning empty arrays for
action items/open questions; collapsing it needs its own before/after
quality comparison on Sonnet and is left as a future experiment, not bundled
here.

## 2. Root Cause (why cost is high)

`generate_notes` runs 3 independent passes (notes/summary, action items,
open questions), each its own `provider.complete_json(&prompt)` call. Claude's
`input_budget_words()` is 100k (`crates/meeting-notes-summary/src/claude.rs:57-61`),
which effectively disables chunking for any real meeting transcript, so a
38-minute meeting is one chunk — but that one chunk's full transcript text is
sent 3 separate times, once per pass (`notes.rs:257-263`), because each pass
builds its own prompt as `format!("{}\n\n{TRANSCRIPT_CAVEAT}\n\nTranscript:\n{chunk}", pass.prompt)`.
The transcript, not the guidance prose, is the dominant cost.

Separately, the Claude request body
(`crates/meeting-notes-summary/src/claude.rs:64-68`) has no `system` field at
all — `GENERIC_GUIDANCE` (which is phrased as a persona: "You write detailed
meeting notes from raw transcripts…") and everything else is packed into a
single `user` message.

## 3. Changes

### 3.1 Prompt caching via system/user split

Restructure each Claude API call into:

- **`system`** — a short constant persona line + `TRANSCRIPT_CAVEAT`, marked
  with `cache_control: {"type": "ephemeral"}`. This content is identical on
  every single API call the app ever makes, regardless of pass or meeting.
- **`user`**, two content blocks:
  1. `"Transcript:\n{chunk}"` — its own `cache_control` breakpoint. Identical
     across a meeting's 3 passes (this is the fix for the 3x-resend), varies
     meeting to meeting.
  2. The pass-specific task — meeting-type guidance + `NOTES_SHAPE` for the
     notes pass, `PASS_ACTIONS`/`PASS_QUESTIONS` for the other two — sent
     uncached, since it's small and not shared across passes.

Anthropic bills a cache write at ~1.25x normal input price and a cache read
at ~0.1x. Pass 1 (which writes the cache) gets slightly more expensive;
passes 2 and 3 (which read it) drop to ~10% of their current transcript
cost. Net effect should be a large reduction in total input tokens billed
per meeting, with no change to any pass's output.

**API surface change:** `SummaryProvider::complete_json`
(`crates/meeting-notes-core/src/summary.rs:55`) currently takes one flat
`&str`. It needs to accept the three parts separately (system / cached
transcript block / task block) so `ClaudeProvider` can emit real Anthropic
content blocks with `cache_control`. `OllamaProvider` has no caching
concept and simply concatenates the three parts into one string, as today.
This touches:

- the trait definition (`meeting-notes-core/src/summary.rs`)
- `ClaudeProvider::complete_json` (`meeting-notes-summary/src/claude.rs`)
- `OllamaProvider::complete_json` (`meeting-notes-summary/src/ollama.rs`)
- the call site in `generate_notes` (`meeting-notes-summary/src/notes.rs`)
- every test mock implementing `SummaryProvider`: `notes_tests.rs`,
  `ollama_tests.rs`, `selection_tests.rs`

### 3.2 Model ID fix

`claude.rs:65` currently hardcodes `"claude-sonnet-5"`. Change it to
`"claude-sonnet-4-5-20250929"`.

### 3.3 Decision status tags (quality)

Gemini's Meet notetaker tags each decision with a status (Aligned / Needs
Further Discussion / Disagreed / Shelved) rather than a flat
decided/not-decided list. Adopt the idea without a schema change:
`decisions` stays `Vec<String>` (`SummaryResult.decisions`,
`src/lib/summary.ts:21` stays `string[]`) — the prompt instructs the model
to prefix each entry with its status, e.g. `"[Agreed] Ship v2 API by
Friday."` This is a `NOTES_SHAPE` wording change only
(`meeting-notes-summary/src/notes.rs`), no changes to `merge_partials`, the
Rust struct, or the frontend types.

### 3.4 Prose tightening

Trim `GENERIC_GUIDANCE` and `TRANSCRIPT_CAVEAT` for redundancy. Keep the
specific anti-hallucination clauses as-is (empty-array-over-placeholder,
mis-transcription handling, "write about the meeting not the transcript")
— research into comparable products' prompting approaches confirmed these
are already aligned with industry best practice for grounding/hallucination
guardrails, not the part that's bloated.

## 4. Testing

- New unit tests asserting the Claude request body's content-block
  structure: `cache_control` present on the system block and the transcript
  block, absent on the task block; correct block ordering.
- Existing tests (`notes_tests.rs`, `chunk_tests.rs`) need their
  `SummaryProvider` mocks updated for the new `complete_json` signature, but
  no new assertions — this change doesn't alter `SummaryResult`'s shape or
  `generate_notes`'s output contract.
- No automated way to verify real cache-hit token counts (that's a live
  Anthropic API property, not something a mock can prove). Do one live
  end-to-end summarize run against the real API and inspect the response's
  `usage` block (`cache_creation_input_tokens` / `cache_read_input_tokens`)
  before calling this done.

## 5. Explicitly Not Changed

- The 3-pass pipeline structure (notes / actions / questions stays 3 calls).
- `SummaryResult`'s schema and the frontend's `Summary` type.
- Ollama's request behavior beyond simple concatenation (no caching support
  added there — Ollama has no equivalent mechanism in how this app uses it).
- Chunking behavior (`split_transcript`, `input_budget_words()`).
