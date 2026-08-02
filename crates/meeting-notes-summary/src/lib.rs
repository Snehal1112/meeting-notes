pub mod claude;
pub mod ollama;

use meeting_notes_core::config::Config;
use meeting_notes_core::summary::SummaryProvider;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ProviderKind {
    Claude,
    Ollama,
}

/// Claude is preferred when both are configured (higher MVP quality per the
/// design doc); Ollama is used when only it is available; None means the app
/// should show its "not configured" state.
pub fn select_provider_kind(config: &Config) -> Option<ProviderKind> {
    if config.claude_api_key.is_some() {
        Some(ProviderKind::Claude)
    } else if config.ollama_endpoint.is_some() {
        Some(ProviderKind::Ollama)
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
            None,
        ))),
    }
}

#[cfg(test)]
mod claude_tests;
#[cfg(test)]
mod ollama_tests;
#[cfg(test)]
mod selection_tests;
