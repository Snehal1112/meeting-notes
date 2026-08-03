pub mod claude;
pub mod ollama;
pub mod chunk;

use meeting_notes_core::config::Config;
use meeting_notes_core::summary::SummaryProvider;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ProviderKind {
    Claude,
    Ollama,
}

/// Ollama is preferred when both are configured: configuring a local
/// endpoint is a deliberate act, and it keeps transcripts on the machine at
/// no per-call cost. The Claude API key is the backup for when no local
/// endpoint is set up. None means the app should show its "not configured"
/// state.
pub fn select_provider_kind(config: &Config) -> Option<ProviderKind> {
    if config.ollama_endpoint.is_some() {
        Some(ProviderKind::Ollama)
    } else if config.claude_api_key.is_some() {
        Some(ProviderKind::Claude)
    } else {
        None
    }
}

/// Builds the provider selected for `config`, or None when no provider is
/// configured. The unwraps are safe: `select_provider_kind` only returns a
/// kind whose corresponding config field is Some.
pub fn build_provider(config: &Config) -> Option<Box<dyn SummaryProvider + Send + Sync>> {
    match select_provider_kind(config)? {
        ProviderKind::Claude => Some(Box::new(claude::ClaudeProvider::new(
            config.claude_api_key.clone().unwrap(),
        ))),
        ProviderKind::Ollama => Some(Box::new(ollama::OllamaProvider::new(
            config.ollama_endpoint.clone().unwrap(),
            config.ollama_model.clone(),
        ))),
    }
}

#[cfg(test)]
mod chunk_tests;
#[cfg(test)]
mod claude_tests;
#[cfg(test)]
mod ollama_tests;
#[cfg(test)]
mod selection_tests;
