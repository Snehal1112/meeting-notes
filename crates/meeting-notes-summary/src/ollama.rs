use async_trait::async_trait;
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};
use serde_json::json;
use std::time::Duration;

const PROMPT_PREFIX: &str = "You summarize meeting transcripts. Respond with ONLY a JSON object \
of the form {\"summary\": string, \"action_items\": string[]}. No preamble, no markdown fences. \
Keep the summary to 3-5 sentences. Extract action items as short imperative phrases.\n\nTranscript:\n";

/// Model used when the config does not name one. Kept generic on purpose:
/// whichever model the user has pulled locally is their choice, and this is
/// only the fallback.
const DEFAULT_MODEL: &str = "llama3";

/// Hard cap on how long a single Ollama call is allowed to hang, mirroring
/// the same protection on the Claude provider. It is much longer than
/// Claude's because local generation on CPU is slow, but a bound is still
/// needed so a stalled endpoint cannot block the summarize flow forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

pub struct OllamaProvider {
    endpoint: String,
    model: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(endpoint: String, model: Option<String>) -> Self {
        // Building a client only fails in a broken environment, never from
        // user input, so panicking here matches ClaudeProvider rather than
        // threading a Result through every call site.
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("failed to build reqwest client for Ollama");
        OllamaProvider {
            endpoint,
            model: model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            client,
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

        let status = response.status();
        if !status.is_success() {
            let body_text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("<failed to read response body: {e}>"));
            return Err(format!("Ollama returned status {status}: {body_text}"));
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
