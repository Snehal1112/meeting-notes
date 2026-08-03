use super::ollama;
use meeting_notes_core::summary::SummaryProvider;

#[test]
fn uses_the_configured_model_when_one_is_given() {
    let provider =
        ollama::OllamaProvider::new("http://localhost:11434".into(), Some("gemma4:e2b".into()));
    assert_eq!(provider.model(), "gemma4:e2b");
}

#[test]
fn falls_back_to_the_default_model_when_none_is_configured() {
    let provider = ollama::OllamaProvider::new("http://localhost:11434".into(), None);
    assert_eq!(provider.model(), ollama::DEFAULT_MODEL);
}

#[tokio::test]
#[ignore] // requires a running local Ollama with the model below pulled
async fn generates_summary_via_real_ollama_endpoint() {
    let endpoint = std::env::var("MEETING_NOTES_OLLAMA_ENDPOINT")
        .unwrap_or_else(|_| "http://localhost:11434".to_string());
    let model = std::env::var("MEETING_NOTES_OLLAMA_MODEL").ok();
    let provider = ollama::OllamaProvider::new(endpoint, model);

    let result = provider
        .generate("Alice: Let's ship the widget by Friday. Bob: I'll write the tests.")
        .await
        .expect("real Ollama call should succeed");

    assert!(!result.summary.is_empty());
}
