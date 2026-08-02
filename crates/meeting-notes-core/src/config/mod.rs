use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub claude_api_key: Option<String>,
    pub ollama_endpoint: Option<String>,
    /// Name of the Ollama model to generate with, e.g. "gemma4:e2b". Which
    /// models exist is per-machine (whatever the user has pulled), so this
    /// has no universally correct value and falls back to the provider's
    /// own default when unset.
    pub ollama_model: Option<String>,
    pub whisper_model: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            claude_api_key: std::env::var("MEETING_NOTES_CLAUDE_API_KEY").ok(),
            ollama_endpoint: std::env::var("MEETING_NOTES_OLLAMA_ENDPOINT").ok(),
            ollama_model: std::env::var("MEETING_NOTES_OLLAMA_MODEL").ok(),
            whisper_model: std::env::var("MEETING_NOTES_WHISPER_MODEL").ok(),
        }
    }

    /// Fill any None fields in `self` with values from `other`.
    pub fn merge(mut self, other: Config) -> Config {
        self.claude_api_key = self.claude_api_key.or(other.claude_api_key);
        self.ollama_endpoint = self.ollama_endpoint.or(other.ollama_endpoint);
        self.ollama_model = self.ollama_model.or(other.ollama_model);
        self.whisper_model = self.whisper_model.or(other.whisper_model);
        self
    }

    pub fn is_complete_enough(&self) -> bool {
        // Whisper model always has a hardcoded default, so "complete enough"
        // just means the app can run local-only without an LLM provider.
        true
    }
}

pub fn config_file_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")
        .map(|dirs| dirs.config_dir().join("config.toml"))
}

pub fn load_from_file() -> Config {
    let Some(path) = config_file_path() else {
        return Config::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Config::default();
    };
    toml::from_str(&contents).unwrap_or_default()
}

pub fn resolve_config() -> Config {
    Config::from_env().merge(load_from_file())
}

pub fn save_to_file(config: &Config) -> std::io::Result<()> {
    let Some(path) = config_file_path() else {
        return Err(std::io::Error::other("no config dir"));
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let toml_str =
        toml::to_string_pretty(config).map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(path, toml_str)
}

#[cfg(test)]
mod tests;
