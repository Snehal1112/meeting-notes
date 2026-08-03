use super::*;
use meeting_notes_core::config::Config;

fn both_configured() -> Config {
    Config {
        claude_api_key: Some("sk-test".into()),
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_model: None,
        ollama_num_ctx: None,
        summary_provider: None,
        whisper_model: None,
    }
}

#[test]
fn selects_ollama_when_both_configured() {
    let config = Config {
        claude_api_key: Some("sk-test".into()),
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_model: None,
        ollama_num_ctx: None,
        summary_provider: None,
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
        ollama_num_ctx: None,
        summary_provider: None,
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
        ollama_num_ctx: None,
        summary_provider: None,
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
        ollama_num_ctx: None,
        summary_provider: None,
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
        ollama_num_ctx: None,
        summary_provider: None,
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
        ollama_num_ctx: None,
        summary_provider: None,
        whisper_model: None,
    };
    assert!(build_provider(&config).is_some());
}

#[test]
fn an_explicit_claude_choice_wins_over_the_default_ollama_precedence() {
    let mut config = both_configured();
    config.summary_provider = Some("claude".into());
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Claude));
}

#[test]
fn an_explicit_ollama_choice_is_honoured() {
    let mut config = both_configured();
    config.summary_provider = Some("ollama".into());
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Ollama));
}

#[test]
fn a_choice_naming_an_unconfigured_provider_falls_back() {
    // The key was in the environment when the choice was made and has since
    // been removed. Falling back beats failing on a stale choice.
    let mut config = both_configured();
    config.claude_api_key = None;
    config.summary_provider = Some("claude".into());
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Ollama));
}

#[test]
fn an_unrecognised_choice_falls_back_to_the_default_precedence() {
    let mut config = both_configured();
    config.summary_provider = Some("gpt".into());
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Ollama));
}

#[test]
fn a_choice_is_matched_case_insensitively() {
    let mut config = both_configured();
    config.summary_provider = Some("Claude".into());
    assert_eq!(select_provider_kind(&config), Some(ProviderKind::Claude));
}

#[test]
fn an_explicit_choice_cannot_conjure_a_provider_when_none_is_configured() {
    let config = Config {
        summary_provider: Some("claude".into()),
        ..Config::default()
    };
    assert_eq!(select_provider_kind(&config), None);
}

#[test]
fn build_provider_for_kind_returns_none_when_the_requested_kind_is_not_configured() {
    let config = Config {
        ollama_endpoint: Some("http://localhost:11434".into()),
        ..Config::default()
    };
    assert!(build_provider_for_kind(&config, ProviderKind::Claude).is_none());
}

#[test]
fn build_provider_for_kind_returns_a_provider_for_the_requested_kind_regardless_of_the_default() {
    // Both configured; default precedence would pick Ollama, but an explicit
    // override for Claude must still be honoured.
    let config = both_configured();
    assert!(build_provider_for_kind(&config, ProviderKind::Claude).is_some());
    assert!(build_provider_for_kind(&config, ProviderKind::Ollama).is_some());
}

#[test]
fn build_provider_for_kind_falls_back_to_the_default_num_ctx_for_ollama() {
    let config = Config {
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_num_ctx: Some(0),
        ..Config::default()
    };
    let provider = build_provider_for_kind(&config, ProviderKind::Ollama).expect("provider");
    assert!(
        provider.input_budget_words() > 0,
        "a zero num_ctx must not produce a zero input budget"
    );
}

#[test]
fn an_explicit_zero_num_ctx_falls_back_to_the_default_instead_of_truncating() {
    // 0 must be treated the same as None (unconfigured), not taken literally:
    // taken literally it produces a zero input budget (whole transcript in
    // one chunk) and an Ollama request that silently reverts to Ollama's own
    // 4096-token default, truncating long meetings without any error.
    let config = Config {
        ollama_endpoint: Some("http://localhost:11434".into()),
        ollama_num_ctx: Some(0),
        ..Config::default()
    };
    let provider = build_provider(&config).expect("provider");
    assert!(
        provider.input_budget_words() > 0,
        "a zero num_ctx must not produce a zero input budget"
    );
}
