# Config Resolution System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust config module that resolves settings (Claude API key, Ollama endpoint, whisper model) from env vars first, then a TOML config file, exposed to the frontend via a Tauri command.

**Architecture:** A `Config` struct with an `Option<String>`/`Option<PathBuf>` per setting, loaded by a `resolve_config()` function that checks env vars, then reads `~/.config/meeting-notes/config.toml` for anything still missing. A Tauri command exposes the resolved config (with secrets masked) to the frontend so it can decide whether to show the first-launch dialog.

**Tech Stack:** Rust, `serde`, `toml`, `directories` crate (for config dir resolution)

---

### Task 1: Define Config struct and env var resolution

**Files:**
- Create: `crates/meeting-notes-core/src/config/mod.rs`
- Create: `crates/meeting-notes-core/src/config/tests.rs`
- Modify: `crates/meeting-notes-core/Cargo.toml`
- Modify: `crates/meeting-notes-core/src/lib.rs`

- [ ] **Step 1: Add dependencies**

```bash
cd crates/meeting-notes-core
cargo add serde --features derive
cargo add toml
cargo add directories
```

- [ ] **Step 2: Write failing test for env var resolution**

```rust
// crates/meeting-notes-core/src/config/tests.rs
use super::*;

#[test]
fn resolves_claude_api_key_from_env() {
    std::env::set_var("MEETING_NOTES_CLAUDE_API_KEY", "sk-test-123");
    let config = Config::from_env();
    assert_eq!(config.claude_api_key, Some("sk-test-123".to_string()));
    std::env::remove_var("MEETING_NOTES_CLAUDE_API_KEY");
}

#[test]
fn returns_none_when_env_var_absent() {
    std::env::remove_var("MEETING_NOTES_OLLAMA_ENDPOINT");
    let config = Config::from_env();
    assert_eq!(config.ollama_endpoint, None);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test config::tests -- --nocapture`
Expected: FAIL — `Config` and `from_env` not defined.

- [ ] **Step 4: Implement Config struct and from_env**

```rust
// crates/meeting-notes-core/src/config/mod.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub claude_api_key: Option<String>,
    pub ollama_endpoint: Option<String>,
    pub whisper_model: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            claude_api_key: std::env::var("MEETING_NOTES_CLAUDE_API_KEY").ok(),
            ollama_endpoint: std::env::var("MEETING_NOTES_OLLAMA_ENDPOINT").ok(),
            whisper_model: std::env::var("MEETING_NOTES_WHISPER_MODEL").ok(),
        }
    }

    /// Fill any None fields in `self` with values from `other`.
    pub fn merge(mut self, other: Config) -> Config {
        self.claude_api_key = self.claude_api_key.or(other.claude_api_key);
        self.ollama_endpoint = self.ollama_endpoint.or(other.ollama_endpoint);
        self.whisper_model = self.whisper_model.or(other.whisper_model);
        self
    }

    pub fn is_complete_enough(&self) -> bool {
        // Whisper model always has a hardcoded default, so "complete enough"
        // just means the app can run local-only without an LLM provider.
        true
    }
}

#[cfg(test)]
mod tests;
```

Register the module in `crates/meeting-notes-core/src/lib.rs`: `pub mod config;`

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p meeting-notes-core config::tests -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-core/src/config crates/meeting-notes-core/Cargo.toml crates/meeting-notes-core/src/lib.rs
git commit -m "feat: add Config struct with env var resolution"
```

---

### Task 2: Config file (TOML) loading with precedence

**Files:**
- Modify: `crates/meeting-notes-core/src/config/mod.rs`
- Modify: `crates/meeting-notes-core/src/config/tests.rs`

- [ ] **Step 1: Write failing test for file loading + precedence**

```rust
#[test]
fn env_takes_precedence_over_file() {
    let file_config = Config {
        claude_api_key: Some("from-file".into()),
        ollama_endpoint: Some("http://file-endpoint".into()),
        whisper_model: Some("base.en".into()),
    };
    std::env::set_var("MEETING_NOTES_CLAUDE_API_KEY", "from-env");
    let env_config = Config::from_env();
    let resolved = env_config.merge(file_config);
    assert_eq!(resolved.claude_api_key, Some("from-env".to_string()));
    assert_eq!(resolved.ollama_endpoint, Some("http://file-endpoint".to_string()));
    std::env::remove_var("MEETING_NOTES_CLAUDE_API_KEY");
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
```

- [ ] **Step 2: Run test to verify it fails on the missing pieces**

Run: `cargo test -p meeting-notes-core config::tests -- --nocapture`
Expected: `merge` test passes already (built in Task 1); `loads_config_from_toml_string` should pass too since `Config` derives `Deserialize`. If it fails, check `crates/meeting-notes-core/Cargo.toml` has `toml` dependency and `Config` derives are correct.

- [ ] **Step 3: Implement file path resolution + loader function**

```rust
use std::path::PathBuf;

pub fn config_file_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")
        .map(|dirs| dirs.config_dir().join("config.toml"))
}

pub fn load_from_file() -> Config {
    let Some(path) = config_file_path() else {
        return Config::default();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Config::default();
    };
    toml::from_str(&contents).unwrap_or_default()
}

pub fn resolve_config() -> Config {
    Config::from_env().merge(load_from_file())
}

pub fn save_to_file(config: &Config) -> std::io::Result<()> {
    let Some(path) = config_file_path() else {
        return Err(std::io::Error::new(std::io::ErrorKind::Other, "no config dir"));
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let toml_str = toml::to_string_pretty(config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::write(path, toml_str)
}
```

- [ ] **Step 4: Run full config test suite**

Run: `cargo test -p meeting-notes-core config:: -- --nocapture`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-core/src/config
git commit -m "feat: add config file loading with env-var precedence"
```

---

### Task 3: Expose resolved config to frontend via Tauri command

**Files:**
- Modify: `src-tauri/Cargo.toml` (confirm `meeting-notes-core` path dependency, added in plan 01 Task 1)
- Create: `src-tauri/src/commands/config_commands.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src/lib/config.ts`

- [ ] **Step 1: Add Tauri command**

```rust
// src-tauri/src/commands/config_commands.rs
use meeting_notes_core::config::{resolve_config, save_to_file};
use meeting_notes_core::config::Config;

#[tauri::command]
pub fn get_config() -> Config {
    resolve_config()
}

#[tauri::command]
pub fn save_config(config: Config) -> Result<(), String> {
    save_to_file(&config).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_needs_setup() -> bool {
    let config = resolve_config();
    config.claude_api_key.is_none() && config.ollama_endpoint.is_none()
}
```

Register `mod commands;` (with `mod config_commands;` inside `commands/mod.rs`) and add the three commands to the `tauri::generate_handler![]` list in `main.rs`. `src-tauri` calls into `meeting-notes-core` only — it never touches env vars or the filesystem directly for config.

- [ ] **Step 2: Add TypeScript wrapper**

```ts
// src/lib/config.ts
import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  claude_api_key: string | null;
  ollama_endpoint: string | null;
  whisper_model: string | null;
}

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (config: AppConfig) => invoke<void>("save_config", { config });
export const configNeedsSetup = () => invoke<boolean>("config_needs_setup");
```

- [ ] **Step 3: Verify manually**

Run: `bun run tauri dev`, open devtools console, run `window.__TAURI__.core.invoke("config_needs_setup")` (or call `configNeedsSetup()` from a temporary `useEffect` with `console.log`).
Expected: returns `true` when no env vars/config file are set.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands src-tauri/src/main.rs src/lib/config.ts
git commit -m "feat: expose config resolution to frontend via Tauri commands"
```
