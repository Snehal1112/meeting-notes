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
    // Reproduces the real Claude response shape when thinking is enabled via
    // the `thinking` request parameter: content[0] is a thinking block
    // (empty text, since display defaults to "omitted") rather than the
    // text block. Before the fix, content[0]["text"] was null here and
    // generate() failed with "unexpected Claude API response shape" on
    // every such call.
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
        .complete_json(
            "You are a test assistant.",
            "n/a",
            r#"Respond with ONLY {"ok": true} and nothing else."#,
        )
        .await
        .expect("real Claude API call should succeed");

    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(parsed["ok"], true);
}

#[test]
fn request_body_marks_system_and_transcript_as_cacheable_but_not_task() {
    let body = claude::build_request_body("persona and caveat", "Transcript:\nhello", "pass-specific task");

    assert_eq!(body["system"][0]["text"], "persona and caveat");
    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");

    let content = &body["messages"][0]["content"];
    assert_eq!(content[0]["text"], "Transcript:\nhello");
    assert_eq!(content[0]["cache_control"]["type"], "ephemeral");
    assert_eq!(content[1]["text"], "pass-specific task");
    assert!(
        content[1].get("cache_control").is_none(),
        "the task block varies every call and must not be marked cacheable"
    );
}

#[test]
fn request_body_uses_the_current_sonnet_model_id() {
    let body = claude::build_request_body("s", "t", "k");
    assert_eq!(body["model"], "claude-sonnet-4-5-20250929");
}
