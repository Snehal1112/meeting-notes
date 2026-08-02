# LLM Provider Abstraction + Claude API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Define a `SummaryProvider` trait and implement it against the Claude API, producing a `{ summary, action_items }` result from a transcript.

**Architecture:** `SummaryResult` and the `SummaryProvider` trait are shared domain types defined in `meeting-notes-core` (so any crate can depend on "what a summary provider does" without pulling in `reqwest` or any concrete implementation). `ClaudeProvider` lives in the `meeting-notes-summary` crate and implements the trait using `reqwest` to call the Anthropic Messages API with a structured prompt instructing the model to return JSON only, which is parsed directly.

**Tech Stack:** Rust, `reqwest` (with `blocking` or async — using async to match the app's async command pattern), `serde_json`, `tokio`

---

### Task 1: Define SummaryResult + SummaryProvider trait in core

**Files:**
- Create: `crates/meeting-notes-core/src/summary.rs`
- Modify: `crates/meeting-notes-core/src/lib.rs`
- Modify: `crates/meeting-notes-core/Cargo.toml`
- Create: `crates/meeting-notes-core/src/summary_tests.rs`

- [x] **Step 1: Write failing test using a mock provider**

```rust
// crates/meeting-notes-core/src/summary_tests.rs
use super::summary::*;
use async_trait::async_trait;

struct MockProvider;

#[async_trait]
impl SummaryProvider for MockProvider {
    async fn generate(&self, _transcript: &str) -> Result<SummaryResult, String> {
        Ok(SummaryResult {
            summary: "Team discussed Q3 roadmap.".into(),
            action_items: vec!["Send roadmap doc".into()],
        })
    }
}

#[tokio::test]
async fn mock_provider_returns_summary_result() {
    let provider = MockProvider;
    let result = provider.generate("some transcript text").await.unwrap();
    assert_eq!(result.summary, "Team discussed Q3 roadmap.");
    assert_eq!(result.action_items.len(), 1);
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-core summary -- --nocapture`
Expected: FAIL — `SummaryProvider` trait and `SummaryResult` not defined. Add dependencies from within `crates/meeting-notes-core`: `cargo add async-trait` and `cargo add --dev tokio --features full`.

- [x] **Step 3: Define the trait and result struct**

```rust
// crates/meeting-notes-core/src/summary.rs
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryResult {
    pub summary: String,
    pub action_items: Vec<String>,
}

#[async_trait]
pub trait SummaryProvider {
    async fn generate(&self, transcript: &str) -> Result<SummaryResult, String>;
}
```

Register in `crates/meeting-notes-core/src/lib.rs`: `pub mod summary;` and `#[cfg(test)] mod summary_tests;`

- [x] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-core summary -- --nocapture`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-core/src crates/meeting-notes-core/Cargo.toml
git commit -m "feat: define SummaryProvider trait and SummaryResult struct in core"
```

---

### Task 2: Claude API implementation with structured prompt

**Files:**
- Create: `crates/meeting-notes-summary/src/claude.rs`
- Modify: `crates/meeting-notes-summary/src/lib.rs`
- Modify: `crates/meeting-notes-summary/Cargo.toml`
- Create: `crates/meeting-notes-summary/src/claude_tests.rs`

- [x] **Step 1: Write failing test for JSON response parsing (no network call)**

```rust
// crates/meeting-notes-summary/src/claude_tests.rs
use super::claude;

#[test]
fn parses_valid_claude_json_response() {
    let raw = r#"{"summary": "Discussed budget.", "action_items": ["Follow up with finance"]}"#;
    let result = claude::parse_summary_response(raw).unwrap();
    assert_eq!(result.summary, "Discussed budget.");
    assert_eq!(result.action_items, vec!["Follow up with finance"]);
}

#[test]
fn returns_error_on_malformed_json() {
    let raw = "not json at all";
    assert!(claude::parse_summary_response(raw).is_err());
}
```

Register `pub mod claude;` and `#[cfg(test)] mod claude_tests;` in `crates/meeting-notes-summary/src/lib.rs`.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: FAIL — `claude::parse_summary_response` not defined.

- [x] **Step 3: Implement ClaudeProvider**

```rust
// crates/meeting-notes-summary/src/claude.rs
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use async_trait::async_trait;
use serde_json::json;

const SYSTEM_PROMPT: &str = "You summarize meeting transcripts. Respond with ONLY a JSON object \
of the form {\"summary\": string, \"action_items\": string[]}. No preamble, no markdown fences. \
Keep the summary to 3-5 sentences. Extract action items as short imperative phrases.";

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
    async fn generate(&self, transcript: &str) -> Result<SummaryResult, String> {
        let body = json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
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

        let parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("failed to parse Claude API response: {e}"))?;

        let text = parsed["content"][0]["text"]
            .as_str()
            .ok_or("unexpected Claude API response shape")?;

        parse_summary_response(text)
    }
}
```

Add dependencies from within `crates/meeting-notes-summary`: `cargo add reqwest --features json`, `cargo add async-trait serde_json`, and `cargo add meeting-notes-core --path ../meeting-notes-core` (if not already present from plan 01 Task 1).

- [x] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: PASS (parsing tests need no network; leave a `#[tokio::test] #[ignore]` real-network test as a manual verification step, not part of the automated suite)

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-summary/src crates/meeting-notes-summary/Cargo.toml
git commit -m "feat: implement ClaudeProvider for summary generation"
```

---

### Task 3: Async Tauri command wiring transcript → Claude summary

**Files:**
- Modify: `src-tauri/Cargo.toml` (confirm `meeting-notes-core`/`meeting-notes-storage`/`meeting-notes-summary` path dependencies, added in plan 01 Task 1)
- Create: `src-tauri/src/commands/summary_commands.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src/lib/summary.ts`

- [x] **Step 1: Implement summarize_meeting command**

```rust
// src-tauri/src/commands/summary_commands.rs
use meeting_notes_core::config::resolve_config;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use meeting_notes_storage::{base_dir, update_meeting};
use meeting_notes_summary::claude::ClaudeProvider;
use tauri::{AppHandle, Emitter};

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
    let Some(api_key) = config.claude_api_key else {
        return Err("no_provider_configured".to_string());
    };

    let provider = ClaudeProvider::new(api_key);
    let result = provider.generate(&transcript).await?;

    std::fs::write(
        meeting_dir.join("summary.md"),
        format!(
            "{}\n\n## Action Items\n{}",
            result.summary,
            result.action_items.iter().map(|i| format!("- [x] {i}")).collect::<Vec<_>>().join("\n")
        ),
    )
    .map_err(|e| e.to_string())?;

    let action_items_json: Vec<serde_json::Value> = result
        .action_items
        .iter()
        .enumerate()
        .map(|(i, text)| serde_json::json!({ "id": i.to_string(), "text": text, "completed": false }))
        .collect();
    std::fs::write(
        meeting_dir.join("action_items.json"),
        serde_json::to_string_pretty(&action_items_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Done;
    update_meeting(&base, &updated).map_err(|e| e.to_string())?;
    app.emit("summary-complete", &updated).map_err(|e| e.to_string())?;

    Ok(result)
}
```

Register `summarize_meeting` in `generate_handler![]`.

- [x] **Step 2: Add TypeScript wrapper**

```ts
// src/lib/summary.ts
import { invoke } from "@tauri-apps/api/core";
import type { MeetingMeta } from "@/lib/storage";

export interface SummaryResult {
  summary: string;
  action_items: string[];
}

export const summarizeMeeting = (meeting: MeetingMeta) =>
  invoke<SummaryResult>("summarize_meeting", { meeting });
```

- [x] **Step 3: Manual verification**

With a valid `MEETING_NOTES_CLAUDE_API_KEY` set, run `bun run tauri dev`, record and transcribe a short meeting, then call `summarizeMeeting(meeting)` from devtools console with the meeting object logged in plan 08's step 3.
Expected: returns `{ summary, action_items }`; `summary.md` and `action_items.json` appear in the meeting directory.

- [x] **Step 4: Commit**

```bash
git add src-tauri/src/commands/summary_commands.rs src-tauri/src/main.rs src/lib/summary.ts
git commit -m "feat: add summarize_meeting command using ClaudeProvider"
```
