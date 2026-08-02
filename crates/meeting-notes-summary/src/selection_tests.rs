use super::*;
use meeting_notes_core::config::Config;

#[test]
fn selects_ollama_when_both_configured() {
    let config = Config {
        claude_api_key: Some("sk-test".into()),
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_model: None,
        whisper_model: None,
    };
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Ollama));
}

#[test]
fn selects_claude_when_only_claude_configured() {
    let config = Config {
        claude_api_key: Some("sk-test".into()),
        ollama_endpoint: None,
        ollama_model: None,
        whisper_model: None,
    };
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Claude));
}

#[test]
fn selects_ollama_when_only_ollama_configured() {
    let config = Config {
        claude_api_key: None,
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_model: None,
        whisper_model: None,
    };
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Ollama));
}

#[test]
fn selects_none_when_neither_configured() {
    let config = Config {
        claude_api_key: None,
        ollama_endpoint: None,
        ollama_model: None,
        whisper_model: None,
    };
    assert_eq!(select_provider_kind(&config), None);
}

#[test]
fn build_provider_returns_none_when_neither_configured() {
    let config = Config {
        claude_api_key: None,
        ollama_endpoint: None,
        ollama_model: None,
        whisper_model: None,
    };
    assert!(build_provider(&config).is_none());
}

#[test]
fn build_provider_returns_a_provider_when_configured() {
    let config = Config {
        claude_api_key: None,
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_model: None,
        whisper_model: None,
    };
    assert!(build_provider(&config).is_some());
}
