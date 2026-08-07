# Meeting History — Backend Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plan 22 (persists `summary_result.json`, needed here for snippet extraction) and plan 24 (removes Done, establishes `openPath` as the standard "show the user a file" mechanism reused here for "reveal in file manager"). Pairs with plan 28 (frontend), which this plan's commands are built for.

**Goal:** Backend support for browsing meeting history — one command returning every meeting with enough data to render a full row (title, date, duration, type, status, a short summary snippet, failure reason if applicable), plus `delete_meeting` and `reveal_in_file_manager`.

**Scale decision:** Filtering, searching, and pagination all happen **client-side** in the frontend, not as query parameters on the backend command. A personal local recording app's meeting count is realistically in the tens-to-low-hundreds, not enough to need server-side pagination — `get_meeting_history()` just returns everything, and plan 28 slices/filters it in React state. This keeps the backend to three simple commands instead of a parameterized query API.

> **Deviation (2026-08-07):** This plan's "plan 22" dependency
> (`summary_result.json` persistence) did not actually exist anywhere in
> the repo — no such plan file, and `write_summary_files` in
> `summary_commands.rs` only ever wrote `summary.md`/`action_items.json`.
> Closed by adding a `summary_result.json` write there (the raw
> `SummaryResult` as JSON) before implementing Task 1's snippet
> extraction, exactly as this plan assumed once that gap was closed.
>
> Task 1's `failure_reason` guess (an `error.txt` file) also didn't exist,
> and both `mark_meeting_failed` functions (`transcription_commands.rs`,
> `summary_commands.rs`) discarded the real error string entirely. Closed
> by adding `error_message: Option<String>` directly to `MeetingMeta`
> (serde default) instead of a new file — `MeetingHistoryEntry` flattens
> `meta` in, so `failure_reason` was dropped as its own field; the error
> text is just `meta.error_message`.
>
> Commands register in `lib.rs`'s `invoke_handler` + `commands/mod.rs`'s
> module list in this repo, not `main.rs` as the plan's steps say. Each
> command reuses the existing `resolved_base_dir()` helper from
> `commands/mod.rs` rather than duplicating its `resolve_config()` +
> `base_dir()` logic inline. `reveal_in_file_manager` mirrors
> `storage_commands::open_summary`'s pattern exactly (index lookup +
> direct `AppHandle::opener()` call, bypassing the opener plugin's static
> ACL scope) rather than the plan's simpler sketch.
>
> Manual verification (Task 3 Step 2) is still owed — untouched by this
> deviation, still needs a live `bun run tauri dev` pass.

---

### Task 1: get_meeting_history — full list with snippets

**Files:**
- Create: `src-tauri/src/commands/history_commands.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `crates/meeting-notes-storage/src/tests.rs`

- [ ] **Step 1: Write failing test for snippet extraction**

```rust
// crates/meeting-notes-storage/src/tests.rs (additions)
#[test]
fn extracts_summary_snippet_from_summary_result_json() {
    let dir = tempdir().unwrap();
    let meeting_dir = dir.path().join("meetings").join("test-meeting");
    std::fs::create_dir_all(&meeting_dir).unwrap();
    std::fs::write(
        meeting_dir.join("summary_result.json"),
        r#"{"summary": "Discussed Q3 roadmap timeline and blockers on the API migration in detail across the whole hour."}"#,
    ).unwrap();

    let snippet = extract_summary_snippet(&meeting_dir, 60);
    assert_eq!(snippet, Some("Discussed Q3 roadmap timeline and blockers on the API migrat…".to_string()));
}

#[test]
fn returns_none_snippet_when_no_summary_result_exists() {
    let dir = tempdir().unwrap();
    let meeting_dir = dir.path().join("meetings").join("no-summary-yet");
    std::fs::create_dir_all(&meeting_dir).unwrap();
    assert_eq!(extract_summary_snippet(&meeting_dir, 60), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-storage snippet -- --nocapture`
Expected: FAIL — `extract_summary_snippet` not defined.

- [ ] **Step 3: Implement snippet extraction**

```rust
// crates/meeting-notes-storage/src/lib.rs (additions)
use std::path::Path;

/// Reads the `summary` field out of summary_result.json (plan 22) and
/// truncates to `max_chars`, appending an ellipsis if truncated. Returns
/// None if the file doesn't exist yet (meeting still processing/failed
/// before ever reaching summarization) rather than erroring — the caller
/// decides what to show in that case (plan 28: the failure reason instead).
pub fn extract_summary_snippet(meeting_dir: &Path, max_chars: usize) -> Option<String> {
    let contents = std::fs::read_to_string(meeting_dir.join("summary_result.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let summary = parsed.get("summary")?.as_str()?;

    if summary.chars().count() <= max_chars {
        Some(summary.to_string())
    } else {
        let truncated: String = summary.chars().take(max_chars).collect();
        Some(format!("{truncated}…"))
    }
}
```

Note: this reads the real `summary` field per the actual `SummaryResult` shape confirmed in project knowledge (`attendees`, `referenced_people`, `summary`, `topics`, `decisions`, `action_items`, `open_questions` — plan 13's structured format, not this sandbox's earlier superseded `discussion_notes`/`what_went_well` design). Verify the field name against the real `summary_result.json` on disk before assuming this matches exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-storage snippet -- --nocapture`
Expected: PASS

- [ ] **Step 5: Add the history entry struct and command**

```rust
// src-tauri/src/commands/history_commands.rs
use meeting_notes_core::meeting::MeetingMeta;
use meeting_notes_storage::{base_dir, extract_summary_snippet, load_index};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct MeetingHistoryEntry {
    #[serde(flatten)]
    pub meta: MeetingMeta,
    pub snippet: Option<String>,
    pub failure_reason: Option<String>,
}

#[tauri::command]
pub fn get_meeting_history() -> Result<Vec<MeetingHistoryEntry>, String> {
    let config = meeting_notes_core::config::resolve_config();
    let base = base_dir(config.data_dir.as_ref().map(std::path::PathBuf::from).as_deref())
        .ok_or("could not resolve data directory")?;
    let index = load_index(&base).map_err(|e| e.to_string())?;

    let entries = index
        .into_iter()
        .map(|meta| {
            let meeting_dir = meta.dir_path(&base);
            let snippet = extract_summary_snippet(&meeting_dir, 80);
            let failure_reason = if meta.status == meeting_notes_core::meeting::MeetingStatus::Failed {
                std::fs::read_to_string(meeting_dir.join("error.txt")).ok()
            } else {
                None
            };
            MeetingHistoryEntry { meta, snippet, failure_reason }
        })
        .collect();

    Ok(entries)
}
```

Note: `error.txt` as the failure-reason source is an assumption — verify against how the real transcription-retry UI (referenced in project knowledge as already existing) actually surfaces its error message today; there may already be a place this gets written that this should read from instead of introducing a new file.

Register `get_meeting_history` in `main.rs`'s `generate_handler![]`.

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-storage/src src-tauri/src/commands/history_commands.rs src-tauri/src/main.rs
git commit -m "feat: add get_meeting_history command with summary snippets"
```

---

### Task 2: delete_meeting

**Files:**
- Modify: `src-tauri/src/commands/history_commands.rs`
- Modify: `crates/meeting-notes-storage/src/tests.rs`

- [ ] **Step 1: Write failing test for deletion**

```rust
// crates/meeting-notes-storage/src/tests.rs (additions)
#[test]
fn delete_meeting_removes_directory_and_index_entry() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "To Delete", MeetingType::AutoDetect).unwrap();
    append_to_index(base.path(), &meta).unwrap();
    assert!(meta.dir_path(base.path()).exists());

    delete_meeting(base.path(), &meta.id).unwrap();

    assert!(!meta.dir_path(base.path()).exists());
    let index = load_index(base.path()).unwrap();
    assert!(index.iter().all(|m| m.id != meta.id));
}

#[test]
fn delete_meeting_is_a_noop_error_for_unknown_id() {
    let base = tempdir().unwrap();
    let result = delete_meeting(base.path(), "does-not-exist");
    assert!(result.is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-storage delete_meeting -- --nocapture`
Expected: FAIL — `delete_meeting` not defined.

- [ ] **Step 3: Implement delete_meeting in the storage crate**

```rust
// crates/meeting-notes-storage/src/lib.rs (additions)
pub fn delete_meeting(base: &Path, meeting_id: &str) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    let Some(pos) = index.iter().position(|m| m.id == meeting_id) else {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "meeting not found"));
    };
    let meta = index.remove(pos);

    let meeting_dir = meta.dir_path(base);
    if meeting_dir.exists() {
        std::fs::remove_dir_all(&meeting_dir)?;
    }

    save_index_public(base, &index)
}

// If `save_index` isn't already `pub` (it's referenced as a private helper
// in earlier plans' code samples), either make it pub or add a small public
// wrapper — this function needs to write the updated index back to disk.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-storage delete_meeting -- --nocapture`
Expected: PASS

- [ ] **Step 5: Expose the Tauri command**

```rust
// src-tauri/src/commands/history_commands.rs (additions)
use meeting_notes_storage::delete_meeting as delete_meeting_impl;

#[tauri::command]
pub fn delete_meeting(meeting_id: String) -> Result<(), String> {
    let config = meeting_notes_core::config::resolve_config();
    let base = base_dir(config.data_dir.as_ref().map(std::path::PathBuf::from).as_deref())
        .ok_or("could not resolve data directory")?;
    delete_meeting_impl(&base, &meeting_id).map_err(|e| e.to_string())
}
```

Register in `main.rs`.

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-storage/src src-tauri/src/commands/history_commands.rs src-tauri/src/main.rs
git commit -m "feat: add delete_meeting command"
```

---

### Task 3: reveal_in_file_manager

**Files:**
- Modify: `src-tauri/src/commands/history_commands.rs`

- [ ] **Step 1: Implement using the opener plugin already added in plan 24**

```rust
// src-tauri/src/commands/history_commands.rs (additions)
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn reveal_in_file_manager(app: tauri::AppHandle, meeting_id: String) -> Result<(), String> {
    let config = meeting_notes_core::config::resolve_config();
    let base = base_dir(config.data_dir.as_ref().map(std::path::PathBuf::from).as_deref())
        .ok_or("could not resolve data directory")?;
    let index = load_index(&base).map_err(|e| e.to_string())?;
    let meta = index
        .iter()
        .find(|m| m.id == meeting_id)
        .ok_or("meeting not found")?;

    // Opening the directory itself (not a specific file within it) makes
    // most file managers open a window showing its contents — this is the
    // standard "reveal" behavior on both Linux and macOS for a folder path.
    app.opener()
        .open_path(meta.dir_path(&base).to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
```

Note: the exact `tauri-plugin-opener` API (`OpenerExt`, `open_path` signature) should be verified against whatever version plan 24 actually resolved — this targets the crate's documented shape, same caveat pattern as other plans referencing external crate APIs.

Register in `main.rs`.

- [ ] **Step 2: Manual verification**

Run: `bun run tauri dev` (once plan 28's frontend calls this), trigger "Reveal in file manager" on a real meeting.
Expected: the OS file manager (Nautilus on Ubuntu, Finder on macOS) opens a window showing that meeting's directory contents (`audio.wav`, `transcript.json`, `summary.md`, etc.).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/history_commands.rs src-tauri/src/main.rs
git commit -m "feat: add reveal_in_file_manager command"
```
