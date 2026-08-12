use async_trait::async_trait;
use meeting_notes_core::summary::SummaryProvider;
use serde_json::json;
use std::time::Duration;

/// Hard cap on how long a single Claude API call is allowed to hang. Without
/// this, a stalled connection blocks the summarize flow indefinitely with no
/// path back to a resolved meeting status.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub struct ClaudeProvider {
    api_key: String,
    client: reqwest::Client,
}

impl ClaudeProvider {
    pub fn new(api_key: String) -> Self {
        // Building a client only fails in a broken environment (e.g. TLS
        // backend issues), never from user input, so a hard panic here is an
        // acceptable MVP tradeoff rather than threading a Result through
        // every call site.
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("failed to build reqwest client for Claude API");
        ClaudeProvider { api_key, client }
    }
}

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

/// Extracts the text of the first text-type block from a parsed Claude API
/// response body. Scans the `content` array rather than assuming
/// `content[0]` is the text block: with thinking on (the default on
/// claude-sonnet-5 when the `thinking` request parameter is omitted),
/// `content[0]` is a `{"type": "thinking", ...}` block instead, and this
/// scan is robust to that regardless of whether thinking is on, off, or
/// future content-block types get added.
///
/// Also surfaces a clear error for a truncated response (`stop_reason ==
/// "max_tokens"`) rather than letting it fall through to a generic "failed
/// to parse LLM response as JSON" error from `notes::parse_pass_fragment`.
pub fn extract_response_text(parsed: &serde_json::Value) -> Result<&str, String> {
    if parsed["stop_reason"] == "max_tokens" {
        return Err(
            "Claude response was truncated (hit max_tokens) before completing".to_string(),
        );
    }

    parsed["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .ok_or_else(|| "unexpected Claude API response shape".to_string())
}

#[async_trait]
impl SummaryProvider for ClaudeProvider {
    fn input_budget_words(&self) -> usize {
        // The context window is 200k tokens, far beyond any meeting
        // transcript, so this effectively disables chunking for Claude.
        100_000
    }

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

        let status = response.status();
        if !status.is_success() {
            // The Anthropic error body ({"type":"error","error":{"type","message"}})
            // never echoes the API key, so it's safe to include verbatim.
            let body_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("<failed to read response body: {e}>"));
            return Err(format!("Claude API returned status {status}: {body_text}"));
        }

        let parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("failed to parse Claude API response: {e}"))?;

        extract_response_text(&parsed).map(|s| s.to_string())
    }
}
