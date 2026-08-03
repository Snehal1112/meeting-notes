use async_trait::async_trait;
use meeting_notes_core::summary::SummaryProvider;
use serde_json::json;
use std::time::Duration;

/// Model used when the config does not name one. Kept generic on purpose:
/// whichever model the user has pulled locally is their choice, and this is
/// only the fallback.
pub const DEFAULT_MODEL: &str = "gemma4:e2b";

/// Hard cap on how long a single Ollama call is allowed to hang, mirroring
/// the same protection on the Claude provider. It is much longer than
/// Claude's because local generation on CPU is slow, but a bound is still
/// needed so a stalled endpoint cannot block the summarize flow forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

pub struct OllamaProvider {
    endpoint: String,
    model: String,
    num_ctx: u32,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(endpoint: String, model: Option<String>, num_ctx: u32) -> Self {
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
            num_ctx,
            client,
        }
    }

    /// The model this provider will generate with, after the default has
    /// been applied.
    pub fn model(&self) -> &str {
        &self.model
    }
}

#[async_trait]
impl SummaryProvider for OllamaProvider {
    fn input_budget_words(&self) -> usize {
        // English runs about 0.75 words per token, and the prompt plus the
        // generated response must share num_ctx with the transcript. Half
        // the window, scaled by that ratio, leaves comfortable headroom.
        (self.num_ctx as usize / 2) * 3 / 4
    }

    async fn complete_json(&self, prompt: &str) -> Result<String, String> {
        let body = json!({
            "model": self.model,
            "prompt": prompt,
            "stream": false,
            "format": "json",
            "options": {
                // Without this Ollama applies its 4096 default and silently
                // drops the front of the prompt.
                "num_ctx": self.num_ctx,
                "temperature": 0.2
            }
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

        parsed["response"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "unexpected Ollama response shape".to_string())
    }
}
