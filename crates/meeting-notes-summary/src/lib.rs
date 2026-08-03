pub mod claude;
pub mod ollama;
pub mod chunk;
pub mod notes;

use meeting_notes_core::config::{Config, DEFAULT_NUM_CTX};
use meeting_notes_core::summary::SummaryProvider;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Eq, Clone, Copy, Serialize, Deserialize)]
pub enum ProviderKind {
    Claude,
    Ollama,
}

/// Chooses the provider to summarize with.
///
/// An explicit choice wins, but only when that provider is actually
/// configured: a stored choice goes stale when a key or endpoint is later
/// removed, and falling back beats failing on a decision made under
/// different conditions. With no usable choice, Ollama wins when an endpoint
/// is set, because configuring a local endpoint is a deliberate act that
/// keeps transcripts on the machine at no per-call cost. None means the app
/// should show its "not configured" state.
pub fn select_provider_kind(config: &Config) -> Option<ProviderKind> {
    let chosen = config.summary_provider.as_deref().and_then(|name| {
        if name.eq_ignore_ascii_case("claude") && config.claude_api_key.is_some() {
            Some(ProviderKind::Claude)
        } else if name.eq_ignore_ascii_case("ollama") && config.ollama_endpoint.is_some() {
            Some(ProviderKind::Ollama)
        } else {
            None
        }
    });
    if chosen.is_some() {
        return chosen;
    }

    if config.ollama_endpoint.is_some() {
        Some(ProviderKind::Ollama)
    } else if config.claude_api_key.is_some() {
        Some(ProviderKind::Claude)
    } else {
        None
    }
}

/// Builds the provider selected for `config`, or None when no provider is
/// configured.
pub fn build_provider(config: &Config) -> Option<Box<dyn SummaryProvider + Send + Sync>> {
    build_provider_for_kind(config, select_provider_kind(config)?)
}

/// Builds a provider for an explicitly requested `kind`, ignoring
/// `select_provider_kind`'s auto-selection — for callers (like a per-call
/// "regenerate with the other provider" action) that already know which
/// provider they want. Returns None when that specific kind isn't
/// configured, even if the other one is.
pub fn build_provider_for_kind(
    config: &Config,
    kind: ProviderKind,
) -> Option<Box<dyn SummaryProvider + Send + Sync>> {
    match kind {
        ProviderKind::Claude => config
            .claude_api_key
            .clone()
            .map(|key| Box::new(claude::ClaudeProvider::new(key)) as Box<dyn SummaryProvider + Send + Sync>),
        ProviderKind::Ollama => config.ollama_endpoint.clone().map(|endpoint| {
            Box::new(ollama::OllamaProvider::new(
                endpoint,
                config.ollama_model.clone(),
                // An explicit 0 (hand-edited config file, or
                // MEETING_NOTES_OLLAMA_NUM_CTX=0) must fall back to the
                // default too, not just an absent value: 0 flows through to
                // input_budget_words() as "whole transcript in one chunk" and
                // to Ollama's request body, where it silently reverts to
                // Ollama's own 4096 default and truncates — exactly the bug
                // this default exists to prevent.
                config.ollama_num_ctx.filter(|n| *n > 0).unwrap_or(DEFAULT_NUM_CTX),
            )) as Box<dyn SummaryProvider + Send + Sync>
        }),
    }
}

#[cfg(test)]
mod chunk_tests;
#[cfg(test)]
mod claude_tests;
#[cfg(test)]
mod notes_tests;
#[cfg(test)]
mod ollama_tests;
#[cfg(test)]
mod selection_tests;
