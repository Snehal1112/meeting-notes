# Notion-Style Summary Format & Attendee Identification Implementation Plan

> # ⛔ SUPERSEDED — DO NOT EXECUTE
>
> Plan 13 (`2026-08-02-13-structured-meeting-notes.md`) shipped this plan's
> goals first, against a different architecture. Every task below is written
> against the pre-plan-13 code and **running it would revert working,
> verified features**:
>
> | Task | Would revert |
> |---|---|
> | 1 | `SummaryResult` → a 2-variant enum, losing `topics`, `open_questions`, `referenced_people`, `summary`, `meeting_type`, and the `#[serde(default)]` that makes the multi-pass merge possible |
> | 1 | `SummaryProvider` → `generate(transcript, prompt_text)`. The shipped trait is `complete_json` + `input_budget_words`, transport-only so prompts live once in the summary crate |
> | 2 | Reintroduces `parse_summary_response`, deleted in plan 13 |
> | 2 | Model id → `claude-sonnet-4-6`. Repo is on `claude-sonnet-5` (`f73ffe4`) |
> | 2 | Drops Ollama's `options.num_ctx` — **this is the silent-truncation bug behind the thin summaries that prompted plan 13** |
> | 3 | Removes chunking (`split_transcript` / `merge_partials`) |
> | 3 | Rewrites `summarize_meeting`, dropping plan 12's `run_summarize_or_mark_failed`. Also wrong signature: takes `MeetingMeta`, actual is `meeting_id: String` |
> | 3 | Adds a `render_summary_markdown` duplicating `notes_markdown.rs` |
>
> It also cannot start: it depends on `templates::template_for` /
> `prompt_text_for` from plan 17 task 3, which was reshaped into
> `notes_pass_for`. And it uses `assignee` where the code uses `owner`.
>
> **Where its goals actually landed:**
>
> - structured result with attendees + assignee-tagged actions → plan 13
>   (`attendees`, `referenced_people`, `ActionItem::owner`)
> - type-aware prompts → plan 17 task 3, reshaped (`notes_pass_for`)
> - Notion-style `summary.md` → `notes_markdown.rs`, rendering the reference
>   document supplied as the standard
> - assignees in the frontend → `ActionItemsList.tsx`
> - attendees in the frontend → commit `585d5c3`, the only piece still
>   outstanding when this plan was reviewed
>
> Nothing here is left to do. Kept for provenance.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plan 17 (meeting types + prompt templates) being complete.

**Goal:** Upgrade `SummaryResult` from the flat `{ summary, action_items: string[] }` shape (plan 09) to a structured, template-aware result with attendees and assignee-tagged action items; wire `ClaudeProvider`/`OllamaProvider` to use plan 17's templates; render `summary.md` in the correct format per meeting type; update the frontend to display attendees and assignees.

**Architecture:** `SummaryResult` in `meeting-notes-core` becomes an enum-like structure holding either the Notion-style fields or the Retrospective/Auto-detect fields, tagged by which template produced it. `SummaryProvider::generate` now takes the transcript **and** the selected `PromptTemplate`, using `templates::prompt_text_for()` as the system/instruction prompt instead of each provider hardcoding its own. `summarize_meeting` in `src-tauri` selects the template via `templates::template_for(meeting.meeting_type)` before calling the provider.

**Tech Stack:** Rust, `serde_json`, React, TypeScript

---

### Task 1: Restructure SummaryResult in core for attendees + assignees + multiple formats

**Files:**
- Modify: `crates/meeting-notes-core/src/summary.rs`
- Modify: `crates/meeting-notes-core/src/summary_tests.rs`

- [ ] **Step 1: Write failing test for the new SummaryResult shape**

```rust
// crates/meeting-notes-core/src/summary_tests.rs (additions)
#[test]
fn notion_style_summary_result_serializes_with_expected_fields() {
    let result = SummaryResult::NotionStyle {
        attendees: vec!["Priya".into(), "Sam".into()],
        discussion_notes: "Discussed the Q3 outage.".into(),
        decisions: vec!["Roll back the deploy".into()],
        action_items: vec![ActionItem { text: "File postmortem".into(), assignee: Some("Priya".into()) }],
    };
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("Priya"));
    assert!(json.contains("File postmortem"));
}

#[test]
fn retrospective_summary_result_serializes_with_expected_fields() {
    let result = SummaryResult::Retrospective {
        attendees: vec!["Sam".into()],
        what_went_well: vec!["Good pairing".into()],
        what_didnt_go_well: vec!["Slow CI".into()],
        action_items: vec![ActionItem { text: "Speed up CI".into(), assignee: None }],
    };
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("what_went_well"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-core summary -- --nocapture`
Expected: FAIL — new `SummaryResult` shape and `ActionItem` don't exist yet (this replaces the flat struct from plan 09).

- [ ] **Step 3: Replace the flat SummaryResult with the tagged structure**

```rust
// crates/meeting-notes-core/src/summary.rs (replace the old SummaryResult struct)
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub text: String,
    pub assignee: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "format")]
pub enum SummaryResult {
    #[serde(rename = "notion_style")]
    NotionStyle {
        attendees: Vec<String>,
        discussion_notes: String,
        decisions: Vec<String>,
        action_items: Vec<ActionItem>,
    },
    #[serde(rename = "retrospective")]
    Retrospective {
        attendees: Vec<String>,
        what_went_well: Vec<String>,
        what_didnt_go_well: Vec<String>,
        action_items: Vec<ActionItem>,
    },
}

impl SummaryResult {
    pub fn attendees(&self) -> &[String] {
        match self {
            SummaryResult::NotionStyle { attendees, .. } => attendees,
            SummaryResult::Retrospective { attendees, .. } => attendees,
        }
    }

    pub fn action_items(&self) -> &[ActionItem] {
        match self {
            SummaryResult::NotionStyle { action_items, .. } => action_items,
            SummaryResult::Retrospective { action_items, .. } => action_items,
        }
    }
}

#[async_trait]
pub trait SummaryProvider {
    async fn generate(
        &self,
        transcript: &str,
        prompt_text: &str,
    ) -> Result<SummaryResult, String>;
}
```

Note the trait signature change: `generate` now takes `prompt_text: &str` (supplied by the caller via `templates::prompt_text_for()`) instead of each provider hardcoding its own system prompt — this is what makes the type-aware templates from plan 17 actually take effect.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-core summary -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-core/src
git commit -m "feat: restructure SummaryResult with attendees, assignees, and format tagging"
```

---

### Task 2: Update ClaudeProvider/OllamaProvider to use externally-supplied prompts

**Files:**
- Modify: `crates/meeting-notes-summary/src/claude.rs`
- Modify: `crates/meeting-notes-summary/src/ollama.rs`
- Modify: `crates/meeting-notes-summary/src/claude_tests.rs`
- Modify: `crates/meeting-notes-summary/src/ollama_tests.rs`

- [ ] **Step 1: Update parse_summary_response tests for the new tagged shape**

```rust
// crates/meeting-notes-summary/src/claude_tests.rs (replace existing tests)
use super::claude;
use meeting_notes_core::summary::SummaryResult;

#[test]
fn parses_notion_style_response() {
    let raw = r#"{"format":"notion_style","attendees":["Priya"],"discussion_notes":"Discussed budget.","decisions":["Cut travel spend"],"action_items":[{"text":"Follow up with finance","assignee":"Priya"}]}"#;
    let result = claude::parse_summary_response(raw).unwrap();
    match result {
        SummaryResult::NotionStyle { attendees, .. } => assert_eq!(attendees, vec!["Priya"]),
        _ => panic!("expected NotionStyle variant"),
    }
}
```

(Mirror the equivalent test in `ollama_tests.rs` for `ollama::parse_summary_response`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: FAIL — `generate` signatures don't match the new trait yet.

- [ ] **Step 3: Update ClaudeProvider to accept an external prompt**

```rust
// crates/meeting-notes-summary/src/claude.rs (modify)
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use async_trait::async_trait;
use serde_json::json;

pub struct ClaudeProvider {
    api_key: String,
    client: reqwest::Client,
}

impl ClaudeProvider {
    pub fn new(api_key: String) -> Self {
        ClaudeProvider { api_key, client: reqwest::Client::new() }
    }
}

pub fn parse_summary_response(raw: &str) -> Result<SummaryResult, String> {
    serde_json::from_str(raw).map_err(|e| format!("failed to parse LLM response as JSON: {e}"))
}

#[async_trait]
impl SummaryProvider for ClaudeProvider {
    async fn generate(&self, transcript: &str, prompt_text: &str) -> Result<SummaryResult, String> {
        let body = json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 1024,
            "system": prompt_text,
            "messages": [{ "role": "user", "content": transcript }]
        });

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

        if !response.status().is_success() {
            return Err(format!("Claude API returned status {}", response.status()));
        }

        let parsed: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        let text = parsed["content"][0]["text"]
            .as_str()
            .ok_or("unexpected Claude API response shape")?;
        parse_summary_response(text)
    }
}
```

- [ ] **Step 4: Update OllamaProvider the same way**

```rust
// crates/meeting-notes-summary/src/ollama.rs (modify generate)
#[async_trait]
impl SummaryProvider for OllamaProvider {
    async fn generate(&self, transcript: &str, prompt_text: &str) -> Result<SummaryResult, String> {
        let prompt = format!("{prompt_text}\n\nTranscript:\n{transcript}");
        let body = json!({
            "model": self.model,
            "prompt": prompt,
            "stream": false,
            "format": "json"
        });
        // ... rest unchanged (POST to /api/generate, parse "response" field via
        // ollama::parse_summary_response)
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-summary/src
git commit -m "feat: update Claude/Ollama providers to use externally-supplied type-aware prompts"
```

---

### Task 3: Wire template selection into summarize_meeting, render Notion-style summary.md

**Files:**
- Modify: `src-tauri/src/commands/summary_commands.rs`
- Modify: `src/lib/summary.ts`
- Modify: `src/components/ActionItemsList.tsx`
- Modify: `src/components/RecorderWidget.tsx`

- [ ] **Step 1: Update summarize_meeting to select the template and render the correct markdown**

```rust
// src-tauri/src/commands/summary_commands.rs (modify)
use meeting_notes_core::summary::SummaryResult;
use meeting_notes_summary::{build_provider, templates};

#[tauri::command]
pub async fn summarize_meeting(
    app: AppHandle,
    meeting: MeetingMeta,
) -> Result<SummaryResult, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meeting_dir = meeting.dir_path(&base);
    let transcript = std::fs::read_to_string(meeting_dir.join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))?;

    let config = resolve_config();
    let Some(provider) = build_provider(&config) else {
        return Err("not_configured".to_string());
    };

    let template = templates::template_for(meeting.meeting_type);
    let prompt_text = templates::prompt_text_for(&template);
    let result = provider.generate(&transcript, prompt_text).await?;

    std::fs::write(meeting_dir.join("summary.md"), render_summary_markdown(&result))
        .map_err(|e| e.to_string())?;
    std::fs::write(
        meeting_dir.join("action_items.json"),
        serde_json::to_string_pretty(result.action_items()).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Done;
    update_meeting(&base, &updated).map_err(|e| e.to_string())?;
    app.emit("summary-complete", &updated).map_err(|e| e.to_string())?;

    Ok(result)
}

fn render_summary_markdown(result: &SummaryResult) -> String {
    let attendees_line = format!("## Attendees\n{}\n", result.attendees().join(", "));
    let action_items_block = result
        .action_items()
        .iter()
        .map(|item| match &item.assignee {
            Some(a) => format!("- [ ] {} ({a})", item.text),
            None => format!("- [ ] {}", item.text),
        })
        .collect::<Vec<_>>()
        .join("\n");

    match result {
        SummaryResult::NotionStyle { discussion_notes, decisions, .. } => format!(
            "{attendees_line}\n## Discussion Notes\n{discussion_notes}\n\n## Decisions\n{}\n\n## Action Items\n{action_items_block}",
            decisions.iter().map(|d| format!("- {d}")).collect::<Vec<_>>().join("\n")
        ),
        SummaryResult::Retrospective { what_went_well, what_didnt_go_well, .. } => format!(
            "{attendees_line}\n## What Went Well\n{}\n\n## What Didn't Go Well\n{}\n\n## Action Items\n{action_items_block}",
            what_went_well.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n"),
            what_didnt_go_well.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n"),
        ),
    }
}
```

- [ ] **Step 2: Update frontend types and ActionItemsList for assignees**

```ts
// src/lib/summary.ts (replace)
export interface ActionItem {
  text: string;
  assignee: string | null;
}

export type SummaryResult =
  | { format: "notion_style"; attendees: string[]; discussion_notes: string; decisions: string[]; action_items: ActionItem[] }
  | { format: "retrospective"; attendees: string[]; what_went_well: string[]; what_didnt_go_well: string[]; action_items: ActionItem[] };
```

```tsx
// src/components/ActionItemsList.tsx (modify to show assignee)
<span className={item.completed ? "line-through text-muted-foreground" : ""}>
  {item.text}
  {item.assignee && <span className="text-muted-foreground"> — {item.assignee}</span>}
</span>
```

- [ ] **Step 3: Update RecorderWidget's Done state to render attendees + the correct format**

```tsx
// src/components/RecorderWidget.tsx (modify done-state summary rendering)
{summaryResult?.format === "notion_style" && (
  <>
    <p className="text-xs text-muted-foreground">Attendees: {summaryResult.attendees.join(", ") || "Not identified"}</p>
    <p>{summaryResult.discussion_notes}</p>
  </>
)}
{summaryResult?.format === "retrospective" && (
  <>
    <p className="text-xs text-muted-foreground">Attendees: {summaryResult.attendees.join(", ") || "Not identified"}</p>
    <p className="font-medium mt-2">What Went Well</p>
    <ul>{summaryResult.what_went_well.map((i, idx) => <li key={idx}>{i}</li>)}</ul>
    <p className="font-medium mt-2">What Didn't Go Well</p>
    <ul>{summaryResult.what_didnt_go_well.map((i, idx) => <li key={idx}>{i}</li>)}</ul>
  </>
)}
```

Update the `actionItems` derivation effect to read from `summaryResult.action_items` (now `ActionItem[]` with `assignee`) instead of a flat `string[]`.

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`, record a short meeting where someone says their name (e.g. "Hi, this is Priya"), pick each meeting type, generate a summary.
Expected: Standup/Incident/Feature Request meetings render Attendees/Discussion Notes/Decisions/Action Items; Retrospective renders Attendees/What Went Well/What Didn't Go Well/Action Items; attendee names appear when stated in the transcript and the list is empty (not guessed) when no names are said.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/summary_commands.rs src/lib/summary.ts src/components/ActionItemsList.tsx src/components/RecorderWidget.tsx
git commit -m "feat: render Notion-style and retrospective summaries with attendees and assignees"
```
