use super::claude;
use meeting_notes_core::summary::SummaryProvider;

#[test]
fn parses_valid_claude_json_response() {
    let raw = r#"{"summary": "Discussed budget.", "action_items": ["Follow up with finance"]}"#;
    let result = claude::parse_summary_response(raw).unwrap();
    assert_eq!(result.summary, "Discussed budget.");
    assert_eq!(result.action_items, vec!["Follow up with finance"]);
}

#[test]
fn returns_error_on_malformed_json() {
    let raw = "not json at all";
    assert!(claude::parse_summary_response(raw).is_err());
}

#[tokio::test]
#[ignore] // requires a real MEETING_NOTES_CLAUDE_API_KEY and makes a live network call
async fn generates_summary_via_real_claude_api() {
    let api_key = std::env::var("MEETING_NOTES_CLAUDE_API_KEY")
        .expect("set MEETING_NOTES_CLAUDE_API_KEY to run this test");
    let provider = claude::ClaudeProvider::new(api_key);

    let result = provider
        .generate("Alice: Let's ship the widget by Friday. Bob: I'll write the tests.")
        .await
        .expect("real Claude API call should succeed");

    assert!(!result.summary.is_empty());
}
