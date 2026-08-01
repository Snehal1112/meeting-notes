use super::*;

#[test]
fn resolves_claude_api_key_from_env() {
    unsafe { std::env::set_var("MEETING_NOTES_CLAUDE_API_KEY", "sk-test-123") };
    let config = Config::from_env();
    assert_eq!(config.claude_api_key, Some("sk-test-123".to_string()));
    unsafe { std::env::remove_var("MEETING_NOTES_CLAUDE_API_KEY") };
}

#[test]
fn returns_none_when_env_var_absent() {
    unsafe { std::env::remove_var("MEETING_NOTES_OLLAMA_ENDPOINT") };
    let config = Config::from_env();
    assert_eq!(config.ollama_endpoint, None);
}
