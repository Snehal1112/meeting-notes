# Summary Prompt Caching & Quality Tweaks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the meeting-notes summarizer from billing the full transcript three times per meeting (once per generation pass) by wiring Anthropic prompt caching into `ClaudeProvider`, fix the hardcoded model id, and add a small decision-status-tagging quality improvement — all with no change to `SummaryResult`'s schema or the 3-pass pipeline structure.

**Architecture:** `SummaryProvider::complete_json` moves from one flat prompt string to three explicit parts (`system`, `transcript`, `task`). `ClaudeProvider` sends `system` and `transcript` as separate Anthropic content blocks marked `cache_control: {"type": "ephemeral"}`, so the 2nd and 3rd passes of a meeting (which reuse the same `system`+`transcript`) read them from cache at ~10% of input price instead of paying full price again. `OllamaProvider`, which has no caching concept, just concatenates the three parts as it always concatenated one flat prompt.

**Tech Stack:** Rust (Cargo workspace), `reqwest` + `serde_json` for the Claude/Ollama HTTP calls, `async-trait` for `SummaryProvider`, `tokio::test` for async tests.

## Global Constraints

- Model id must be exactly `claude-sonnet-4-5-20250929` (not `claude-sonnet-5`, not `claude-sonnet-4.6`).
- `SummaryResult.decisions` stays `Vec<String>` — no Rust struct or `src/lib/summary.ts` changes. The decision-status idea is a prompt-wording change only.
- The 3-pass pipeline (notes/summary, action items, open questions) stays exactly 3 `complete_json` calls per transcript chunk — do not consolidate passes.
- `TRANSCRIPT_CAVEAT`'s anti-hallucination clauses (empty-array-over-placeholder, mis-transcription handling, "write about the meeting not the transcript") must be relocated, not reworded or shortened.
- No caching support is added to `OllamaProvider` — it keeps behaving exactly as before (one concatenated prompt string), since Ollama has no equivalent mechanism in how this app uses it.

---

### Task 1: Split `complete_json` into system/transcript/task parts and wire prompt caching into Claude

**Files:**
- Modify: `crates/meeting-notes-core/src/summary.rs:55` (trait method signature)
- Modify: `crates/meeting-notes-summary/src/claude.rs` (new `build_request_body`, updated `complete_json`, model id fix)
- Modify: `crates/meeting-notes-summary/src/claude_tests.rs` (new tests + updated live test call)
- Modify: `crates/meeting-notes-summary/src/ollama.rs:57-68` (updated `complete_json`)
- Modify: `crates/meeting-notes-summary/src/ollama_tests.rs:37-50` (updated live test call)
- Modify: `crates/meeting-notes-summary/src/notes.rs` (new `SYSTEM_PERSONA` const, `GENERIC_GUIDANCE` trim, `generate_notes` call site)
- Modify: `crates/meeting-notes-summary/src/notes_tests.rs:17-58` (`ScriptedProvider`/`FailingProvider` signatures)

**Interfaces:**
- Produces: `SummaryProvider::complete_json(&self, system: &str, transcript: &str, task: &str) -> Result<String, String>` — the new trait signature every provider and every test mock must implement.
- Produces: `pub fn claude::build_request_body(system: &str, transcript: &str, task: &str) -> serde_json::Value` — pure, network-free Claude request-body builder, unit-testable on its own.
- Produces: `notes::SYSTEM_PERSONA: &str` — the persona sentence moved out of `GENERIC_GUIDANCE` into the shared system prompt.

- [ ] **Step 1: Write failing tests for the new `build_request_body` function**

Append to `crates/meeting-notes-summary/src/claude_tests.rs`:

```rust
#[test]
fn request_body_marks_system_and_transcript_as_cacheable_but_not_task() {
    let body = claude::build_request_body("persona and caveat", "Transcript:\nhello", "pass-specific task");

    assert_eq!(body["system"][0]["text"], "persona and caveat");
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");

    let content = &body["messages"][0]["content"];
    assert_eq!(content[0]["text"], "Transcript:\nhello");
    assert_eq!(content[0]["cache_control"]["type"], "ephemeral");
    assert_eq!(content[1]["text"], "pass-specific task");
    assert!(
        content[1].get("cache_control").is_none(),
        "the task block varies every call and must not be marked cacheable"
    );
}

#[test]
fn request_body_uses_the_current_sonnet_model_id() {
    let body = claude::build_request_body("s", "t", "k");
    assert_eq!(body["model"], "claude-sonnet-4-5-20250929");
}
```

- [ ] **Step 2: Run the new tests to verify they fail to compile**

Run: `cargo test -p meeting-notes-summary request_body_ 2>&1 | tail -20`
Expected: compile error, `build_request_body` not found in `claude` module.

- [ ] **Step 3: Implement `build_request_body` and use it from `complete_json`**

In `crates/meeting-notes-summary/src/claude.rs`, add this function above `extract_response_text` and change `complete_json`'s model id:

```rust
/// Builds the Claude Messages API request body. `system` and `transcript`
/// are marked as separate cacheable content blocks (`cache_control:
/// ephemeral`) because they are identical across every pass run for one
/// meeting -- without this, three passes per meeting each pay full
/// input-token price for the same transcript. `task` is the pass-specific
/// instruction and is sent uncached, since it differs every call.
pub fn build_request_body(system: &str, transcript: &str, task: &str) -> serde_json::Value {
    json!({
        "model": "claude-sonnet-4-5-20250929",
        "max_tokens": 8192,
        "system": [
            {
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"}
            }
        ],
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": transcript,
                    "cache_control": {"type": "ephemeral"}
                },
                {
                    "type": "text",
                    "text": task
                }
            ]
        }]
    })
}
```

Leave `extract_response_text` and the `ClaudeProvider` struct/`new` untouched in this step — `complete_json` still takes one `&str` for now, and is updated in Step 5.

- [ ] **Step 4: Run the tests to verify they pass, then commit**

Run: `cargo test -p meeting-notes-summary request_body_`
Expected: both tests PASS.

```bash
git add crates/meeting-notes-summary/src/claude.rs crates/meeting-notes-summary/src/claude_tests.rs
git commit -m "feat: add cache-aware Claude request body builder"
```

- [ ] **Step 5: Change the `SummaryProvider` trait signature**

In `crates/meeting-notes-core/src/summary.rs`, replace:

```rust
    /// Sends `prompt` and returns the raw JSON text of the response.
    async fn complete_json(&self, prompt: &str) -> Result<String, String>;
```

with:

```rust
    /// Sends a prompt built from three parts and returns the raw JSON text
    /// of the response. `system` and `transcript` are identical across
    /// every pass run for the same meeting -- `system` is in fact identical
    /// across every call the app ever makes -- so a provider that supports
    /// prompt caching (see `ClaudeProvider`) should treat them as the
    /// cacheable prefix. `task` is the pass-specific instruction and varies
    /// every call.
    async fn complete_json(&self, system: &str, transcript: &str, task: &str) -> Result<String, String>;
```

- [ ] **Step 6: Rewire `ClaudeProvider::complete_json` to use `build_request_body`**

In `crates/meeting-notes-summary/src/claude.rs`, replace the `complete_json` impl body:

```rust
    async fn complete_json(&self, system: &str, transcript: &str, task: &str) -> Result<String, String> {
        let body = build_request_body(system, transcript, task);

        let response = self
            .client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
```

(the rest of the function — status check, JSON parse, `extract_response_text` call — is unchanged).

- [ ] **Step 7: Rewire `OllamaProvider::complete_json`**

In `crates/meeting-notes-summary/src/ollama.rs`, replace:

```rust
    async fn complete_json(&self, prompt: &str) -> Result<String, String> {
        let body = json!({
            "model": self.model,
            "prompt": prompt,
```

with:

```rust
    async fn complete_json(&self, system: &str, transcript: &str, task: &str) -> Result<String, String> {
        let prompt = format!("{system}\n\n{transcript}\n\n{task}");
        let body = json!({
            "model": self.model,
            "prompt": prompt,
```

(everything else in the function is unchanged).

- [ ] **Step 8: Move the persona sentence out of `GENERIC_GUIDANCE` into a new `SYSTEM_PERSONA` const**

In `crates/meeting-notes-summary/src/notes.rs`, add this new const directly above `GENERIC_GUIDANCE`:

```rust
/// The shared persona line, sent once as part of the cached `system` prompt
/// (see `ClaudeProvider::build_request_body`) rather than repeated inside
/// every meeting-type guidance const.
const SYSTEM_PERSONA: &str = "You write detailed meeting notes from raw transcripts.";
```

Then change `GENERIC_GUIDANCE` (it no longer needs its own opening sentence, since `SYSTEM_PERSONA` now carries it) from:

```rust
const GENERIC_GUIDANCE: &str = "You write detailed meeting notes from raw transcripts. First \
infer what kind of meeting this was — a round of status updates, a working discussion that \
reached decisions, a brainstorm, narration or a recorded talk from one continuous speaker, or a \
conversation with no clear structure at all — and let that inference shape the topics instead of \
forcing a template onto it. Use one topic per \
```

to:

```rust
const GENERIC_GUIDANCE: &str = "First infer what kind of meeting this was — a round of status \
updates, a working discussion that reached decisions, a brainstorm, narration or a recorded \
talk from one continuous speaker, or a conversation with no clear structure at all — and let \
that inference shape the topics instead of forcing a template onto it. Use one topic per \
```

(the rest of `GENERIC_GUIDANCE`, from `"distinct subject in the order..."` through the closing `"Next steps\".";`, is unchanged).

`STANDUP_GUIDANCE`, `RETROSPECTIVE_GUIDANCE`, `FEATURE_REQUEST_GUIDANCE`, and `INCIDENT_GUIDANCE` are left untouched — their opening sentences name the specific meeting type (e.g. "You write notes for a standup"), which `SYSTEM_PERSONA`'s generic wording does not cover, so they are not redundant.

- [ ] **Step 9: Update `generate_notes`'s call site**

In `crates/meeting-notes-summary/src/notes.rs`, replace:

```rust
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
```

with:

```rust
    let chunks = split_transcript(transcript, provider.input_budget_words());
    if chunks.is_empty() {
        return Err("transcript is empty, nothing to summarize".to_string());
    }
    let chunk_total = chunks.len();
    let system = format!("{SYSTEM_PERSONA}\n\n{TRANSCRIPT_CAVEAT}");

    let mut fragments = Vec::new();
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let transcript_block = format!("Transcript:\n{chunk}");
        for pass in &passes {
            on_progress(SummaryProgress { pass: pass.tag, chunk_index, chunk_total });
            let raw = provider.complete_json(&system, &transcript_block, pass.prompt).await?;
            fragments.push(parse_pass_fragment(&raw, pass.required_keys)?);
        }
    }
```

Note `system` is hoisted above the chunk loop (identical for every chunk and pass) and `transcript_block` is hoisted above the pass loop but inside the chunk loop (identical for a chunk's 3 passes, differs across chunks) — this hoisting is exactly what makes the cache actually get reused.

- [ ] **Step 10: Fix the test mocks in `notes_tests.rs`**

In `crates/meeting-notes-summary/src/notes_tests.rs`, replace:

```rust
#[async_trait]
impl SummaryProvider for ScriptedProvider {
    fn input_budget_words(&self) -> usize {
        self.budget
    }
    async fn complete_json(&self, prompt: &str) -> Result<String, String> {
        self.prompts.lock().unwrap().push(prompt.to_string());
        self.responses
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| "no scripted response left".to_string())
    }
}

struct FailingProvider;

#[async_trait]
impl SummaryProvider for FailingProvider {
    fn input_budget_words(&self) -> usize {
        1000
    }
    async fn complete_json(&self, _prompt: &str) -> Result<String, String> {
        Err("endpoint down".to_string())
    }
}
```

with:

```rust
#[async_trait]
impl SummaryProvider for ScriptedProvider {
    fn input_budget_words(&self) -> usize {
        self.budget
    }
    async fn complete_json(&self, system: &str, transcript: &str, task: &str) -> Result<String, String> {
        self.prompts.lock().unwrap().push(format!("{system}\n\n{transcript}\n\n{task}"));
        self.responses
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| "no scripted response left".to_string())
    }
}

struct FailingProvider;

#[async_trait]
impl SummaryProvider for FailingProvider {
    fn input_budget_words(&self) -> usize {
        1000
    }
    async fn complete_json(&self, _system: &str, _transcript: &str, _task: &str) -> Result<String, String> {
        Err("endpoint down".to_string())
    }
}
```

Every existing assertion in `notes_tests.rs` (transcript-presence checks, per-meeting-type prompt uniqueness, shared-prompt equality across meeting types) keeps working unchanged, because `ScriptedProvider` still records one concatenated string per call — only how that string is assembled changed.

- [ ] **Step 11: Fix the two live (`#[ignore]`) integration tests' call sites**

In `crates/meeting-notes-summary/src/claude_tests.rs`, replace:

```rust
    let raw = provider
        .complete_json(r#"Respond with ONLY {"ok": true} and nothing else."#)
        .await
        .expect("real Claude API call should succeed");
```

with:

```rust
    let raw = provider
        .complete_json(
            "You are a test assistant.",
            "n/a",
            r#"Respond with ONLY {"ok": true} and nothing else."#,
        )
        .await
        .expect("real Claude API call should succeed");
```

In `crates/meeting-notes-summary/src/ollama_tests.rs`, replace:

```rust
    let raw = provider
        .complete_json(r#"Respond with ONLY {"ok": true} and nothing else."#)
        .await
        .expect("real Ollama call should succeed");
```

with:

```rust
    let raw = provider
        .complete_json(
            "You are a test assistant.",
            "n/a",
            r#"Respond with ONLY {"ok": true} and nothing else."#,
        )
        .await
        .expect("real Ollama call should succeed");
```

- [ ] **Step 12: Run the full workspace test suite**

Run: `cargo test --workspace 2>&1 | tail -60`
Expected: all non-ignored tests PASS, zero compile errors. (The two `#[ignore]`d live-API tests are exercised manually in Task 3, not here.)

- [ ] **Step 13: Commit**

```bash
git add crates/meeting-notes-core/src/summary.rs \
        crates/meeting-notes-summary/src/claude.rs \
        crates/meeting-notes-summary/src/claude_tests.rs \
        crates/meeting-notes-summary/src/ollama.rs \
        crates/meeting-notes-summary/src/ollama_tests.rs \
        crates/meeting-notes-summary/src/notes.rs \
        crates/meeting-notes-summary/src/notes_tests.rs
git commit -m "feat: split SummaryProvider prompts into cacheable system/transcript/task parts"
```

---

### Task 2: Add decision status tags to the notes pass prompt

**Files:**
- Modify: `crates/meeting-notes-summary/src/notes.rs:44-56` (`NOTES_SHAPE`'s `decisions` bullet)
- Modify: `crates/meeting-notes-summary/src/notes_tests.rs` (new test)

**Interfaces:**
- Consumes: `notes_pass_for(meeting_type: MeetingType) -> String` (unchanged signature, from Task 1).
- No new public interface — this is a prompt-wording-only change; `SummaryResult.decisions` stays `Vec<String>`.

- [ ] **Step 1: Write the failing test**

Append to `crates/meeting-notes-summary/src/notes_tests.rs`:

```rust
#[test]
fn notes_pass_tells_the_model_to_tag_each_decision_with_its_outcome() {
    for meeting_type in ALL_TYPES {
        let prompt = notes_pass_for(meeting_type);
        for tag in ["[Agreed]", "[Disagreed]", "[Shelved]"] {
            assert!(
                prompt.contains(tag),
                "{meeting_type:?} notes pass does not ask for the {tag} decision tag"
            );
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p meeting-notes-summary notes_pass_tells_the_model_to_tag_each_decision_with_its_outcome`
Expected: FAIL — none of the three tags are in the current prompt text.

- [ ] **Step 3: Update the `decisions` bullet in `NOTES_SHAPE`**

In `crates/meeting-notes-summary/src/notes.rs`, replace the `decisions` bullet inside `NOTES_SHAPE` (it is not the last bullet — `topics` follows it and carries the raw string's closing `"#;`, which stays untouched):

```rust
- decisions: things the group actually settled on, one decision per entry, stating what was decided and who it applies to if said. Proposals nobody agreed to are not decisions. Use an empty array if nothing was settled. A proposal counts as settled only if the transcript shows the group taking it up — someone agreeing, or the conversation proceeding on that basis. If the transcript ends on it, or the next thing said moves elsewhere without a response, it stays a proposal and belongs in topics only. Never state something in decisions that your own topics points describe as proposed, suggested, floated, or unresolved.
- topics: split the meeting into the real subjects covered;
```

with:

```rust
- decisions: things the group explicitly settled, disagreed on, or set aside — never a bare list of what got approved. Prefix every entry with its outcome in square brackets: "[Agreed]" when the group settled on it, "[Disagreed]" when they explicitly took different positions on it and never reconciled, or "[Shelved]" when they explicitly set it aside rather than deciding. After the tag, state what was decided, disputed, or shelved, and who it applies to if said. A proposal nobody responded to at all carries none of these outcomes — it stays a proposal and belongs in topics only, not decisions. Use an empty array if the group settled, disputed, or shelved nothing. Never state something in decisions that your own topics points describe as merely proposed, suggested, or floated with no response.
- topics: split the meeting into the real subjects covered;
```

(only the `decisions` line changes; the `- topics:` line is included above only to anchor the edit precisely — leave it and everything after it, including the closing `"#;`, exactly as it is in the file).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p meeting-notes-summary notes_pass_tells_the_model_to_tag_each_decision_with_its_outcome`
Expected: PASS.

- [ ] **Step 5: Run the full `meeting-notes-summary` test suite to check for regressions**

Run: `cargo test -p meeting-notes-summary 2>&1 | tail -40`
Expected: all non-ignored tests PASS — in particular `every_notes_pass_requests_the_keys_the_parser_demands` and `notes_pass_tells_the_model_not_to_invent_placeholder_attendees`, which check unrelated parts of `NOTES_SHAPE` and must be unaffected by this bullet's wording change.

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-summary/src/notes.rs crates/meeting-notes-summary/src/notes_tests.rs
git commit -m "feat: tag each decision with Agreed/Disagreed/Shelved in the notes prompt"
```

---

### Task 3: Verify prompt caching produces real cache hits against the live Claude API

**Files:** none (manual verification only, no code changes)

**Interfaces:**
- Consumes: a real `MEETING_NOTES_CLAUDE_API_KEY` and a real meeting transcript file (e.g. `~/.local/share/meeting-notes/meetings/<id>/transcript.txt` from a prior recording) — needs to be long enough to clear Claude's ~1024-token minimum cacheable block size; any real meeting transcript of a few minutes or longer clears this easily.

This step exists because no unit test can prove a live API actually honors `cache_control` — Task 1's tests only prove the request body is shaped correctly.

- [ ] **Step 1: Build the request body once and fire it twice**

```bash
export MEETING_NOTES_CLAUDE_API_KEY="sk-ant-..."   # your real key
TRANSCRIPT_FILE=~/.local/share/meeting-notes/meetings/<some-meeting-id>/transcript.txt  # any real transcript on disk

BODY=$(jq -n \
  --arg sys "You write detailed meeting notes from raw transcripts." \
  --rawfile transcript_body "$TRANSCRIPT_FILE" \
  --arg task 'Respond with ONLY {"ok": true} and nothing else.' \
  '{
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 100,
    system: [{type: "text", text: $sys, cache_control: {type: "ephemeral"}}],
    messages: [{role: "user", content: [
      {type: "text", text: ("Transcript:\n" + $transcript_body), cache_control: {type: "ephemeral"}},
      {type: "text", text: $task}
    ]}]
  }')

echo "$BODY" | curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $MEETING_NOTES_CLAUDE_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d @- | jq '.usage'
```

Expected output (first call — writes the cache): `cache_creation_input_tokens` is a large positive number roughly matching the transcript's token count; `cache_read_input_tokens` is `0`.

- [ ] **Step 2: Immediately re-run the exact same `$BODY` a second time**

```bash
echo "$BODY" | curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $MEETING_NOTES_CLAUDE_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d @- | jq '.usage'
```

Expected output (second call — reads the cache): `cache_read_input_tokens` is a large positive number, roughly equal to the first call's `cache_creation_input_tokens`; `input_tokens` (the non-cached portion) is small (just the short `task` block).

- [ ] **Step 3: Confirm the numbers, and if not, troubleshoot before considering this done**

If `cache_read_input_tokens` is `0` on the second call: check whether the response includes an error about `cache_control` being unrecognized — if so, add the header `-H "anthropic-beta: prompt-caching-2024-07-31"` to both `curl` calls and retry, since prompt caching may still require the beta header depending on the account/model. If the numbers look right, this confirms the caching architecture from Task 1 works end-to-end against the real API, not just in the unit tests, and this plan is done.
