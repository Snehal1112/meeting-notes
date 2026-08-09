# Meeting History — Backend Implementation Plan

> **Design doc:** `docs/superpowers/specs/2026-08-06-meeting-history-design.md` — read this first, especially §3 ("What's Confirmed vs. What Needs Verification"), which lists the exact assumptions this plan's code makes that need checking against the real repo before being trusted as-is.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plan 22 (persists `summary_result.json`, needed here for snippet extraction). `reveal_in_file_manager` (Task 3) follows the same `AppHandle::opener()`-direct pattern already confirmed in the real `open_summary` command (`storage_commands.rs`), not a frontend `openPath()` call — see Task 3's note for why. Pairs with plan 28 (frontend), which this plan's commands are built for.

**Goal:** Backend support for browsing meeting history — one command returning every meeting with enough data to render a full row (title, date, duration, type, status, a short summary snippet, failure reason if applicable), plus `delete_meeting` and `reveal_in_file_manager`.

**Scale decision:** Filtering, searching, and pagination all happen **client-side** in the frontend, not as query parameters on the backend command. A personal local recording app's meeting count is realistically in the tens-to-low-hundreds, not enough to need server-side pagination — `get_meeting_history()` just returns everything, and plan 28 slices/filters it in React state. This keeps the backend to three simple commands instead of a parameterized query API.

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
use crate::commands::resolved_base_dir;
use meeting_notes_core::meeting::MeetingMeta;
use meeting_notes_storage::{extract_summary_snippet, load_index};
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
    let base = resolved_base_dir()?;
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

**Confirmed against real code (2026-08-06):** `resolved_base_dir()` already
exists as a shared helper in `src-tauri/src/commands/storage_commands.rs`
(`use crate::commands::resolved_base_dir;`), wrapping whatever config
resolution + `base_dir()` override logic the real app uses — this replaces
the plan's earlier speculative `resolve_config()` + `base_dir(...)` call
pair with the actual existing convention. Every command below reuses it.

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
    let base = resolved_base_dir()?;
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

> **Corrected against the real `open_summary` command (2026-08-06)**, which
> already solves the same "open a path chosen at runtime" problem for
> `summary.md`. Its doc comment explains a real constraint this task's
> earlier draft missed entirely: `tauri-plugin-opener`'s `open_path` **IPC
> command** is gated by the `opener:allow-open-path` capability, whose
> scope is static ACL configuration resolved at build/startup — it cannot
> be extended at runtime to "wherever the user's configured data directory
> happens to be" (checked directly against the plugin's `Scope` API, which
> only exposes read-only `is_path_allowed`, no runtime `allow`). Calling
> the frontend's `openPath()` for a meeting folder would hit this same gap.
> The fix `open_summary` already uses — call the plugin's own Rust
> `AppHandle::opener()` API directly from a command *we* control, bypassing
> the IPC command wrapper (and its ACL check) entirely — applies identically
> here. This task now follows that exact pattern instead of the frontend
> `openPath()` call the earlier draft assumed would work.

- [ ] **Step 1: Implement using AppHandle::opener() directly, with the same id validation as open_summary**

```rust
// src-tauri/src/commands/history_commands.rs (additions)
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Opens a meeting's directory in the system's file manager.
///
/// Calls `AppHandle::opener()` directly rather than having the frontend
/// invoke the opener plugin's own IPC command — see the note above and the
/// identical rationale on `open_summary` in `storage_commands.rs`. The path
/// is built here from the server-resolved base dir, never trusted from the
/// caller, so this stays scoped to this app's own meeting directories
/// regardless of the capabilities file.
#[tauri::command]
pub fn reveal_in_file_manager(app: AppHandle, meeting_id: String) -> Result<(), String> {
    // Same validation as open_summary: meeting_id crosses the IPC boundary
    // as a plain client-supplied string, so reject anything that could
    // escape the meetings directory before it ever reaches a filesystem call.
    if meeting_id.is_empty() || meeting_id.contains('/') || meeting_id.contains("..") {
        return Err(format!("invalid meeting id: {meeting_id}"));
    }
    let base = resolved_base_dir()?;
    let meeting_dir = base.join("meetings").join(&meeting_id);

    // Opening the directory itself (not a specific file within it) makes
    // most file managers open a window showing its contents — this is the
    // standard "reveal" behavior on both Linux and macOS for a folder path.
    app.opener()
        .open_path(meeting_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
```

Note: this no longer loads the index to look up the meeting first (the
earlier draft did) — `open_summary` doesn't either, since the id itself is
enough to build the path deterministically via the same
`base.join("meetings").join(id)` convention `MeetingMeta::dir_path` uses
internally. One less file read, and one less way for a stale/missing index
entry to block an otherwise-valid reveal action.

Register `reveal_in_file_manager` in `main.rs`'s `generate_handler![]`,
alongside `get_meeting_history` and `delete_meeting`.

- [ ] **Step 2: Manual verification**

Run: `bun run tauri dev` (once plan 28's frontend calls this), trigger "Reveal in file manager" on a real meeting.
Expected: the OS file manager (Nautilus on Ubuntu, Finder on macOS) opens a window showing that meeting's directory contents (`audio.wav`, `transcript.json`, `summary.md`, etc.). Separately, try passing a crafted `meeting_id` containing `../` (e.g. via devtools console) and confirm it's rejected with the "invalid meeting id" error rather than silently resolving outside the meetings directory.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/history_commands.rs src-tauri/src/main.rs
git commit -m "feat: add reveal_in_file_manager command, matching open_summary's ACL-safe pattern"
```
