use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub claude_api_key: Option<String>,
    pub ollama_endpoint: Option<String>,
    pub whisper_model: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            claude_api_key: std::env::var("MEETING_NOTES_CLAUDE_API_KEY").ok(),
            ollama_endpoint: std::env::var("MEETING_NOTES_OLLAMA_ENDPOINT").ok(),
            whisper_model: std::env::var("MEETING_NOTES_WHISPER_MODEL").ok(),
        }
    }

    /// Fill any None fields in `self` with values from `other`.
    pub fn merge(mut self, other: Config) -> Config {
        self.claude_api_key = self.claude_api_key.or(other.claude_api_key);
        self.ollama_endpoint = self.ollama_endpoint.or(other.ollama_endpoint);
        self.whisper_model = self.whisper_model.or(other.whisper_model);
        self
    }

    pub fn is_complete_enough(&self) -> bool {
        // Whisper model always has a hardcoded default, so "complete enough"
        // just means the app can run local-only without an LLM provider.
        true
    }
}

#[cfg(test)]
mod tests;
