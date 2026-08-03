use super::ollama;
use meeting_notes_core::config::DEFAULT_NUM_CTX;
use meeting_notes_core::summary::SummaryProvider;

fn provider(model: Option<&str>) -> ollama::OllamaProvider {
    ollama::OllamaProvider::new(
        "http://localhost:11434".to_string(),
        model.map(|m| m.to_string()),
        DEFAULT_NUM_CTX,
    )
}

#[test]
fn uses_the_configured_model_when_one_is_given() {
    assert_eq!(provider(Some("gemma4:e2b")).model(), "gemma4:e2b");
}

#[test]
fn falls_back_to_the_default_model_when_none_is_configured() {
    assert_eq!(provider(None).model(), ollama::DEFAULT_MODEL);
}

#[test]
fn budgets_roughly_three_quarters_of_a_word_per_context_token() {
    // Tokens outnumber words, and the prompt and the response both have to
    // fit alongside the transcript, so the budget must be well under num_ctx.
    let budget = provider(None).input_budget_words();
    assert!(budget > 0);
    assert!(
        budget < DEFAULT_NUM_CTX as usize,
        "budget {budget} must leave room for the prompt and response"
    );
}

#[tokio::test]
#[ignore] // requires a running local Ollama with the model below pulled
async fn completes_json_via_real_ollama_endpoint() {
    let endpoint = std::env::var("MEETING_NOTES_OLLAMA_ENDPOINT")
        .unwrap_or_else(|_| "http://localhost:11434".to_string());
    let model = std::env::var("MEETING_NOTES_OLLAMA_MODEL").ok();
    let provider = ollama::OllamaProvider::new(endpoint, model, DEFAULT_NUM_CTX);

    let raw = provider
        .complete_json(r#"Respond with ONLY {"ok": true} and nothing else."#)
        .await
        .expect("real Ollama call should succeed");

    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(parsed["ok"], true);
}
