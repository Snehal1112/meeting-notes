use super::ollama;

#[test]
fn parses_valid_ollama_json_response() {
    let raw = r#"{"summary": "Reviewed sprint progress.", "action_items": ["Update ticket status"]}"#;
    let result = ollama::parse_summary_response(raw).unwrap();
    assert_eq!(result.summary, "Reviewed sprint progress.");
    assert_eq!(result.action_items, vec!["Update ticket status"]);
}
