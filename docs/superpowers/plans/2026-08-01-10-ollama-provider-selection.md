# Ollama Provider + Provider Selection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Ollama-backed `SummaryProvider` implementation and provider-selection logic so `summarize_meeting` picks Claude or Ollama based on config, with a clear "not configured" outcome when neither is available.

**Architecture:** `OllamaProvider` implements the same `SummaryProvider` trait against a local Ollama HTTP endpoint using the same JSON-only prompt contract as Claude. A small `select_provider(config)` function centralizes the choice (Claude preferred if both configured, since it noted higher MVP quality in the design) so `summarize_meeting` doesn't hardcode `ClaudeProvider`.

**Tech Stack:** Rust, `reqwest`, `serde_json`

---

### Task 1: OllamaProvider implementation

**Files:**
- Create: `crates/meeting-notes-summary/src/ollama.rs`
- Modify: `crates/meeting-notes-summary/src/lib.rs`
- Modify: `crates/meeting-notes-summary/src/ollama_tests.rs`

- [ ] **Step 1: Write failing test for Ollama response parsing**

```rust
// crates/meeting-notes-summary/src/ollama_tests.rs
use super::ollama;

#[test]
fn parses_valid_ollama_json_response() {
    let raw = r#"{"summary": "Reviewed sprint progress.", "action_items": ["Update ticket status"]}"#;
    let result = ollama::parse_summary_response(raw).unwrap();
    assert_eq!(result.summary, "Reviewed sprint progress.");
    assert_eq!(result.action_items, vec!["Update ticket status"]);
}
```

Register `#[cfg(test)] mod ollama_tests;` in `crates/meeting-notes-summary/src/lib.rs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: FAIL — `ollama::parse_summary_response` not defined.

- [ ] **Step 3: Implement OllamaProvider**

```rust
// crates/meeting-notes-summary/src/ollama.rs
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use async_trait::async_trait;
use serde_json::json;

const PROMPT_PREFIX: &str = "You summarize meeting transcripts. Respond with ONLY a JSON object \
of the form {\"summary\": string, \"action_items\": string[]}. No preamble, no markdown fences. \
Keep the summary to 3-5 sentences. Extract action items as short imperative phrases.\n\nTranscript:\n";

pub struct OllamaProvider {
    endpoint: String,
    model: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(endpoint: String, model: Option<String>) -> Self {
        OllamaProvider {
            endpoint,
            model: model.unwrap_or_else(|| "llama3".to_string()),
            client: reqwest::Client::new(),
        }
    }
}

pub fn parse_summary_response(raw: &str) -> Result<SummaryResult, String> {
    serde_json::from_str(raw).map_err(|e| format!("failed to parse LLM response as JSON: {e}"))
}

#[async_trait]
impl SummaryProvider for OllamaProvider {
    async fn generate(&self, transcript: &str) -> Result<SummaryResult, String> {
        let prompt = format!("{PROMPT_PREFIX}{transcript}");
        let body = json!({
            "model": self.model,
            "prompt": prompt,
            "stream": false,
            "format": "json"
        });

        let url = format!("{}/api/generate", self.endpoint.trim_end_matches('/'));
        let response = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request to Ollama failed: {e}"))?;

        if !response.status().is_success() {
            return Err(format!("Ollama returned status {}", response.status()));
        }

        let parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("failed to parse Ollama response: {e}"))?;

        let text = parsed["response"]
            .as_str()
            .ok_or("unexpected Ollama response shape")?;

        parse_summary_response(text)
    }
}
```

Add `pub mod ollama;` to `crates/meeting-notes-summary/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-summary/src/ollama.rs crates/meeting-notes-summary/src/lib.rs
git commit -m "feat: implement OllamaProvider for local summary generation"
```

---

### Task 2: Provider selection logic

**Files:**
- Modify: `crates/meeting-notes-summary/src/lib.rs`
- Modify: `crates/meeting-notes-summary/src/ollama_tests.rs`

- [ ] **Step 1: Write failing test for selection precedence**

```rust
// crates/meeting-notes-summary/src/selection_tests.rs
use super::*;
use meeting_notes_core::config::Config;

#[test]
fn selects_claude_when_both_configured() {
    let config = Config {
        claude_api_key: Some("sk-test".into()),
        ollama_endpoint: Some("http://localhost:11434".into()),
        whisper_model: None,
    };
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Claude));
}

#[test]
fn selects_ollama_when_only_ollama_configured() {
    let config = Config {
        claude_api_key: None,
        ollama_endpoint: Some("http://localhost:11434".into()),
        whisper_model: None,
    };
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Ollama));
}

#[test]
fn selects_none_when_neither_configured() {
    let config = Config { claude_api_key: None, ollama_endpoint: None, whisper_model: None };
    assert_eq!(select_provider_kind(&config), None);
}
```

Register `#[cfg(test)] mod selection_tests;` in `crates/meeting-notes-summary/src/lib.rs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: FAIL — `select_provider_kind`, `ProviderKind` not defined.

- [ ] **Step 3: Implement selection logic and provider factory**

```rust
// crates/meeting-notes-summary/src/lib.rs (additions)
use meeting_notes_core::config::Config;
use meeting_notes_core::summary::SummaryProvider;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ProviderKind {
    Claude,
    Ollama,
}

/// Claude is preferred when both are configured (higher MVP quality per design doc);
/// Ollama used when only it is available; None means show "not configured" state.
pub fn select_provider_kind(config: &Config) -> Option<ProviderKind> {
    if config.claude_api_key.is_some() {
        Some(ProviderKind::Claude)
    } else if config.ollama_endpoint.is_some() {
        Some(ProviderKind::Ollama)
    } else {
        None
    }
}

pub fn build_provider(config: &Config) -> Option<Box<dyn SummaryProvider + Send + Sync>> {
    match select_provider_kind(config)? {
        ProviderKind::Claude => Some(Box::new(claude::ClaudeProvider::new(
            config.claude_api_key.clone().unwrap(),
        ))),
        ProviderKind::Ollama => Some(Box::new(ollama::OllamaProvider::new(
            config.ollama_endpoint.clone().unwrap(),
            None,
        ))),
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-summary/src/lib.rs
git commit -m "feat: add provider selection logic (Claude preferred, Ollama fallback)"
```

---

### Task 3: Wire selection into summarize_meeting + "not configured" outcome

**Files:**
- Modify: `src-tauri/src/commands/summary_commands.rs`

- [ ] **Step 1: Replace hardcoded ClaudeProvider with build_provider**

```rust
// src-tauri/src/commands/summary_commands.rs (modify summarize_meeting)
use meeting_notes_core::summary::SummaryResult;
use meeting_notes_summary::build_provider;

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

    let result = provider.generate(&transcript).await?;

    // ... rest unchanged (write summary.md, action_items.json, update status, emit event)
}
```

Remove the now-unused `use meeting_notes_summary::claude::ClaudeProvider;` import from plan 09 Task 3.

- [ ] **Step 2: Manual verification — Ollama path**

Run Ollama locally (`ollama serve`, with a model pulled), unset `MEETING_NOTES_CLAUDE_API_KEY`, set `MEETING_NOTES_OLLAMA_ENDPOINT=http://localhost:11434`, run `bun run tauri dev`, call `summarizeMeeting(meeting)`.
Expected: returns a valid `SummaryResult` generated locally.

- [ ] **Step 3: Manual verification — not configured path**

Unset both `MEETING_NOTES_CLAUDE_API_KEY` and `MEETING_NOTES_OLLAMA_ENDPOINT`, remove/rename the config file, call `summarizeMeeting(meeting)`.
Expected: command rejects with `"not_configured"` string, which the frontend (wired in plan 11) will map to a "Not generated — configure a provider" message.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/summary_commands.rs
git commit -m "feat: select provider dynamically in summarize_meeting, surface not_configured"
```
