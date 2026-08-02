use super::ollama;
use meeting_notes_core::summary::SummaryProvider;

#[test]
fn parses_valid_ollama_json_response() {
    let raw = r#"{"summary": "Reviewed sprint progress.", "action_items": ["Update ticket status"]}"#;
    let result = ollama::parse_summary_response(raw).unwrap();
    assert_eq!(result.summary, "Reviewed sprint progress.");
    assert_eq!(result.action_items, vec!["Update ticket status"]);
}

#[test]
fn returns_error_on_malformed_json() {
    assert!(ollama::parse_summary_response("not json at all").is_err());
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
