use super::*;
use std::sync::{Mutex, MutexGuard};

/// Environment variables are process-global, but cargo runs these tests
/// concurrently in one process — so two tests setting or removing the same
/// variable interleave and read each other's values. Every test that touches
/// the environment must hold this lock for its whole body.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Takes the environment lock, ignoring poisoning: a panicking test (i.e. a
/// failing assertion) must not cascade into spurious failures in every other
/// env-touching test.
fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[test]
fn resolves_claude_api_key_from_env() {
    let _guard = lock_env();
    unsafe { std::env::set_var("MEETING_NOTES_CLAUDE_API_KEY", "sk-test-123") };
    let config = Config::from_env();
    assert_eq!(config.claude_api_key, Some("sk-test-123".to_string()));
    unsafe { std::env::remove_var("MEETING_NOTES_CLAUDE_API_KEY") };
}

#[test]
fn returns_none_when_env_var_absent() {
    let _guard = lock_env();
    unsafe { std::env::remove_var("MEETING_NOTES_OLLAMA_ENDPOINT") };
    let config = Config::from_env();
    assert_eq!(config.ollama_endpoint, None);
}

#[test]
fn env_takes_precedence_over_file() {
    let _guard = lock_env();
    let file_config = Config {
        claude_api_key: Some("from-file".into()),
        ollama_endpoint: Some("http://file-endpoint".into()),
        ollama_model: None,
        ollama_num_ctx: None,
        summary_provider: None,
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
fn resolves_ollama_model_from_env() {
    let _guard = lock_env();
    unsafe { std::env::set_var("MEETING_NOTES_OLLAMA_MODEL", "gemma4:e2b") };
    let config = Config::from_env();
    assert_eq!(config.ollama_model, Some("gemma4:e2b".to_string()));
    unsafe { std::env::remove_var("MEETING_NOTES_OLLAMA_MODEL") };
}

#[test]
fn merge_fills_ollama_model_from_the_file_config() {
    // Builds the env-side Config as a literal rather than calling
    // from_env(), so this test needs no environment access at all and does
    // not have to contend for ENV_LOCK.
    let env_config = Config::default();
    let file_config = Config {
        ollama_model: Some("from-file".into()),
        ..Config::default()
    };
    let resolved = env_config.merge(file_config);
    assert_eq!(resolved.ollama_model, Some("from-file".to_string()));
}

#[test]
fn resolves_ollama_num_ctx_from_env() {
    let _guard = lock_env();
    unsafe { std::env::set_var("MEETING_NOTES_OLLAMA_NUM_CTX", "16384") };
    let config = Config::from_env();
    assert_eq!(config.ollama_num_ctx, Some(16384));
    unsafe { std::env::remove_var("MEETING_NOTES_OLLAMA_NUM_CTX") };
}

#[test]
fn ignores_a_non_numeric_num_ctx_instead_of_failing_startup() {
    let _guard = lock_env();
    unsafe { std::env::set_var("MEETING_NOTES_OLLAMA_NUM_CTX", "lots") };
    let config = Config::from_env();
    assert_eq!(config.ollama_num_ctx, None);
    unsafe { std::env::remove_var("MEETING_NOTES_OLLAMA_NUM_CTX") };
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

/// Pins the property `set_summary_provider` (the config_commands Tauri
/// command) relies on: `load_from_file` reads only the file, never the
/// environment. If this ever regressed to reading the resolved config, an
/// env-only API key would get copied into the plaintext config file the next
/// time the provider picker is clicked.
#[test]
fn load_from_file_does_not_pick_up_environment_values() {
    let _guard = lock_env();
    unsafe { std::env::set_var("MEETING_NOTES_CLAUDE_API_KEY", "sk-env-only") };
    let loaded = load_from_file();
    assert_ne!(loaded.claude_api_key, Some("sk-env-only".to_string()));
    unsafe { std::env::remove_var("MEETING_NOTES_CLAUDE_API_KEY") };
}

#[test]
fn save_to_path_writes_the_file_with_owner_only_permissions() {
    let dir = std::env::temp_dir().join(format!(
        "meeting-notes-config-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let path = dir.join("config.toml");
    let config = Config {
        claude_api_key: Some("sk-test".into()),
        ..Config::default()
    };

    save_to_path(&config, &path).expect("save");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    std::fs::remove_dir_all(&dir).ok();
}
