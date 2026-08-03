use super::claude;

#[test]
fn extracts_text_block_when_it_is_the_first_content_block() {
    let parsed = serde_json::json!({
        "content": [
            {"type": "text", "text": "{\"summary\": \"ok\", \"action_items\": []}"}
        ],
        "stop_reason": "end_turn"
    });

    let text = claude::extract_response_text(&parsed).expect("should extract text");
    assert_eq!(text, "{\"summary\": \"ok\", \"action_items\": []}");
}

#[test]
fn extracts_text_block_when_preceded_by_a_thinking_block() {
    // Reproduces the real claude-sonnet-5 response shape when the `thinking`
    // request parameter is omitted: adaptive thinking runs by default, and
    // content[0] is a thinking block (empty text, since display defaults to
    // "omitted") rather than the text block. Before the fix, content[0]["text"]
    // was null here and generate() failed with "unexpected Claude API response
    // shape" on every real call.
    let parsed = serde_json::json!({
        "content": [
            {"type": "thinking", "thinking": ""},
            {"type": "text", "text": "{\"summary\": \"Discussed roadmap.\", \"action_items\": [\"Follow up\"]}"}
        ],
        "stop_reason": "end_turn"
    });

    let text = claude::extract_response_text(&parsed).expect("should extract text past the thinking block");
    assert_eq!(
        text,
        "{\"summary\": \"Discussed roadmap.\", \"action_items\": [\"Follow up\"]}"
    );
}

#[test]
fn errors_clearly_when_response_was_truncated_by_max_tokens() {
    let parsed = serde_json::json!({
        "content": [
            {"type": "thinking", "thinking": ""}
        ],
        "stop_reason": "max_tokens"
    });

    let err = claude::extract_response_text(&parsed).expect_err("truncated response should error");
    assert!(err.contains("max_tokens"), "error should mention max_tokens, got: {err}");
}

#[test]
fn errors_when_no_text_block_is_present_and_not_truncated() {
    let parsed = serde_json::json!({
        "content": [
            {"type": "thinking", "thinking": ""}
        ],
        "stop_reason": "end_turn"
    });

    assert!(claude::extract_response_text(&parsed).is_err());
}

#[tokio::test]
#[ignore] // requires a real MEETING_NOTES_CLAUDE_API_KEY and makes a live network call
async fn completes_json_via_real_claude_api() {
    use meeting_notes_core::summary::SummaryProvider;
    let api_key = std::env::var("MEETING_NOTES_CLAUDE_API_KEY")
        .expect("set MEETING_NOTES_CLAUDE_API_KEY to run this test");
    let provider = claude::ClaudeProvider::new(api_key);

    let raw = provider
        .complete_json(r#"Respond with ONLY {"ok": true} and nothing else."#)
        .await
        .expect("real Claude API call should succeed");

    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(parsed["ok"], true);
}
