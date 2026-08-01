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

#[test]
fn env_takes_precedence_over_file() {
    let file_config = Config {
        claude_api_key: Some("from-file".into()),
        ollama_endpoint: Some("http://file-endpoint".into()),
        whisper_model: Some("base.en".into()),
    };
    unsafe { std::env::set_var("MEETING_NOTES_CLAUDE_API_KEY", "from-env") };
    let env_config = Config::from_env();
    let resolved = env_config.merge(file_config);
    assert_eq!(resolved.claude_api_key, Some("from-env".to_string()));
    assert_eq!(
        resolved.ollama_endpoint,
        Some("http://file-endpoint".to_string())
    );
    unsafe { std::env::remove_var("MEETING_NOTES_CLAUDE_API_KEY") };
}

#[test]
fn loads_config_from_toml_string() {
    let toml_str = r#"
        claude_api_key = "sk-file-key"
        whisper_model = "small.en"
    "#;
    let config: Config = toml::from_str(toml_str).unwrap();
    assert_eq!(config.claude_api_key, Some("sk-file-key".to_string()));
    assert_eq!(config.ollama_endpoint, None);
}
