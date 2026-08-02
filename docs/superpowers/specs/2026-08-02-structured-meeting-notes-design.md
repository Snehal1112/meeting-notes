# Structured Meeting Notes — Design

**Status:** approved, ready for implementation planning
**Date:** 2026-08-02
**Supersedes:** the flat `SummaryResult { summary, action_items }` shape introduced in plan 09

## Problem

The generated summary is far thinner than the transcript warrants. For a 12-minute,
1571-word meeting the app produced two sentences and three vague action items.

The cause is not, as first suspected, a prompt failing to reach the model. The prompt is
sent correctly — it simply instructs the model to *"Keep the summary to 3-5 sentences.
Extract action items as short imperative phrases."* The model complied exactly. The output
is thin because the prompt asks for thin.

A second, independent defect was found while investigating: `OllamaProvider` never sets
`num_ctx`, so Ollama applies its default of 4096 tokens and **silently truncates the front
of the prompt**. Measured directly: with `num_ctx` unset a 4442-token prompt reported
`prompt_eval_count=4096` and the model could not see the beginning; at `num_ctx=8192` it
evaluated all 4442 tokens. The 1571-word transcript (~2100 tokens) fit, so this meeting was
intact — but a 45–60 minute meeting would lose most of itself with no error raised.

## Goal

Produce meeting notes matching the reference document the user supplied at
`~/.local/share/meeting-notes/meetings/2026-08-02_161819_product-marketing-meeting--wee/summary.md`,
which is the authoritative format for this work.

## Output format

Rendered `summary.md`, section for section:

```markdown
# <meeting title>

**Date:** <YYYY-MM-DD>
**Type:** <model-supplied descriptor>
**Attendees mentioned:** <confirmed> (referenced but not confirmed on the call: <referenced>)
**Recording length:** ~<N> minutes

> Note: this transcript is auto-generated (Whisper ASR) with no speaker diarization, so
> individual lines aren't attributed to named speakers. A few terms are likely
> mis-transcribed and are flagged below with best-guess interpretations.

## Summary
<one substantial paragraph>

## Discussion Notes

### <topic title>
- <specific, detailed point>

## Decisions
- <decision>

## Action Items
- [ ] <task>

## Open Questions
- <question>
```

`Date`, `Recording length` and the title come from `MeetingMeta` in Rust, never from the
model, so they cannot be hallucinated. The ASR caveat is static text. Everything else is
model-supplied.

Rendering rules for absent data:
- Sections with no content are omitted rather than rendered empty.
- The `(referenced but not confirmed on the call: …)` clause is omitted when no referenced
  people were identified.
- `duration_seconds` is null for a meeting that never completed a normal stop, in which case
  the `Recording length` line is omitted rather than showing `~0 minutes`.
- An untitled recording stores an empty title, so the `#` heading falls back to the meeting
  id — matching how `ResumePrompt` already labels untitled meetings.

## Data model

In `meeting-notes-core`:

```rust
pub struct Topic      { pub title: String, pub points: Vec<String> }
pub struct ActionItem { pub text: String, pub owner: Option<String> }

pub struct SummaryResult {
    pub meeting_type: String,
    pub attendees: Vec<String>,
    pub referenced_people: Vec<String>,
    pub summary: String,
    pub topics: Vec<Topic>,
    pub decisions: Vec<String>,
    pub action_items: Vec<ActionItem>,
    pub open_questions: Vec<String>,
}
```

`owner` is `Option<String>` deliberately. The transcript has no speaker diarization, and in
benchmarking the model correctly declined to guess owners rather than inventing them.

## Multi-pass generation

A single prompt asking for all eight fields **does not work on a small local model**.
Measured on `gemma4:e2b` against the real transcript:

| approach | topics | points | decisions | action items | open questions |
|---|---|---|---|---|---|
| reference document | 2 | 19 | 2 | 7 | 3 |
| one combined prompt | 4 | 19 | 3 | **0** | **0** |
| focused per-section calls | 4 | 19 | 3 | **7** | **5** |

The combined prompt silently returned empty arrays for two whole sections. Narrow,
single-purpose prompts recovered them, including correct owner attribution (Parker, Alita).

So generation runs as three passes over the same transcript:

- **Pass A** — `meeting_type`, `attendees`, `referenced_people`, `summary`, `topics`, `decisions`
- **Pass B** — `action_items` (with owners)
- **Pass C** — `open_questions`

Each pass is an independent prompt returning its own JSON fragment; the fragments are
combined into one `SummaryResult` in Rust.

## Chunking for long meetings

`chunk.rs` in `meeting-notes-summary` splits the transcript on a word budget derived from
the provider's input budget, so the budget and the context window cannot drift apart.

For a transcript that fits, each pass runs once. For one that does not, each pass runs per
chunk and the partials are merged **deterministically in Rust**: topics concatenated and
deduplicated by title, decisions / action items / open questions deduplicated. Only the
summary paragraph needs a further model call, rewriting the per-chunk summaries into one.

Keeping the merge in Rust rather than in a large merge prompt makes it unit-testable and
keeps the failure surface small.

If any pass on any chunk fails, the whole summarize fails. Partial notes presented as
complete would be worse than an honest error.

## Provider architecture

`SummaryProvider` currently owns both prompt construction and transport, which forces every
prompt to be duplicated per provider. With three passes that becomes nine copies. The trait
is therefore narrowed to transport only:

```rust
#[async_trait]
pub trait SummaryProvider {
    /// Sends `prompt` and returns the raw JSON text of the response.
    async fn complete_json(&self, prompt: &str) -> Result<String, String>;
    /// Roughly how many transcript words this provider can take at once.
    fn input_budget_words(&self) -> usize;
}
```

All prompts and orchestration move to a provider-agnostic `notes.rs`. Claude reports a large
budget and never chunks; Ollama derives its budget from `num_ctx`. Both run the identical
pipeline.

## Provider selection

The user chooses the provider explicitly, rather than it being decided for them by
precedence. `Config` gains `summary_provider: Option<ProviderKind>`, serialized as
`"ollama"` or `"claude"` and resolved through the existing env → config-file precedence.

Resolution order:

1. If `summary_provider` names a provider **and that provider is configured**, use it.
2. Otherwise fall back to the existing implicit precedence: Ollama when an endpoint is set,
   Claude otherwise.
3. If neither is configured, the existing `not_configured` state applies.

Step 1's "and that provider is configured" guard matters: a stored choice can go stale when
a key or endpoint is later removed from the environment. Falling back beats failing on a
choice the user made under different conditions.

### Picker UI

A small selector in the widget's idle state, above Start Recording:

```
Summarize with: (•) Ollama   ( ) Claude
```

- Only configured providers are selectable. An unconfigured one renders disabled with the
  reason (`no API key set`, `no endpoint set`), because offering a choice that is guaranteed
  to fail is worse than not offering it.
- When exactly one provider is configured it is selected and the picker is informational.
- When neither is configured the picker is hidden; the existing not-configured messaging on
  the done state already covers that case.

Changing the selection persists it, so the choice survives a restart.

**Implementation hazard:** `save_config` writes the whole `Config` struct and
`save_to_file` overwrites the file wholesale. The widget must therefore read the current
config, change only `summary_provider`, and write the result back. Sending a partially
populated `Config` would silently erase the user's API key, endpoint and whisper model.

## Configuration

New `ollama_num_ctx`, resolved through the existing env → config-file precedence, defaulting
to 8192. This is the fix for the silent-truncation defect. 8192 was verified to work within
the available RAM on the target machine; 16384 failed to allocate.

New `summary_provider`, as described above.

## Quality expectations

The reference document is frontier-model quality. Lines such as *"Cindy pushed back on any
forced load-balancing: her count runs higher because she can reuse content across
DevSecOps-themed sessions"* capture reasoning and disagreement that a 5B local model does not
reliably surface. Multi-pass closes most of the **structural** gap; it does not close the
**interpretive** one. Local output will match the format and carry the concrete facts, while
reading shallower than the reference. Claude, when it is the selected provider, should
approach the reference.

This is precisely why the provider picker exists: it lets the user trade privacy and cost
against depth per meeting, instead of that trade-off being fixed by config precedence.

The default Ollama model changes from `llama3` (not a general default anyone has pulled) to
`gemma4:e2b`, which benchmarked better than `deepseek-coder-v2:16b` on this transcript —
more specific, correctly named people, found a decision the code-tuned model missed, and was
faster (51s vs 80s).

## Storage

- `summary.md` — rendered from the struct in Rust, deterministic and testable.
- `action_items.json` — gains `owner`; shape becomes `{ id, text, owner, completed }`.

No migration. Nothing reads previously-written meetings back, because there is no
browse-past-meetings feature; only newly generated notes use the new shape.

## UI

The Summary tab renders Overview, Discussion Notes, Decisions and Open Questions as React
elements — the typed model means no markdown parser is needed. The Action Items tab keeps its
checkboxes, showing the owner alongside the task when one is known.

Long meetings now take minutes rather than seconds, so the processing state shows which pass
is running instead of a single indefinite "Generating summary…".

## Error handling

- A malformed JSON fragment from any pass fails that pass, and so the whole summarize, via
  the existing error path that marks the meeting `Failed`.
- The existing not-configured vs. generation-failed distinction is unchanged.
- Truncation is no longer silent: with `num_ctx` set explicitly and chunking derived from it,
  a transcript that does not fit is split rather than quietly cut.

## Testing

Rust:
- transcript splitting: boundaries, input smaller than one chunk, exact multiples
- partial merging: topic dedupe by title, ordering, action-item and question dedupe
- markdown rendering: full document against a fixture, plus omission of empty sections
- JSON parsing for each pass's fragment shape, including malformed input

- provider selection: an explicit choice is honoured; a stale choice whose provider is no
  longer configured falls back; neither configured yields `not_configured`

Frontend:
- Summary tab renders topics, decisions and open questions
- Action items render with and without an owner
- the picker disables unconfigured providers, hides itself when neither is configured, and
  persists a change without clearing the rest of the config

Not covered by automated tests: whether the model's output is *good*. That is judged by
running the pipeline against the reference transcript and comparing to the reference
document.

## Out of scope

- A full settings screen. The provider picker is a single targeted control in the widget,
  not the general settings surface the original design deferred.
- Re-generating an existing meeting's notes with the other provider. The picker applies to
  the next meeting summarized, not retroactively.
- Speaker diarization. Owners come only from names spoken in the transcript.
- Detecting that a recording cut off mid-sentence (present in the reference document as an
  italic note).
- Re-generating notes for meetings summarized under the old format.
