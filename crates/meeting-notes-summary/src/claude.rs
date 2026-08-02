use async_trait::async_trait;
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
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
        ClaudeProvider {
            api_key,
            client: reqwest::Client::new(),
        }
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
