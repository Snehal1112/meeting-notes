# Meeting File Storage & Index Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the per-meeting directory structure on disk and maintain `index.json` as a lightweight metadata index, plus detect orphaned recordings from interrupted sessions on launch.

**Architecture:** `MeetingMeta`/`MeetingStatus` are shared domain types defined in `meeting-notes-core` (any crate can reference "what a meeting is" without pulling in filesystem logic). The `meeting-notes-storage` crate owns the actual `~/.local/share/meeting-notes/` layout: creating meeting directories, reading/writing `index.json` (an array of `MeetingMeta`), and scanning for orphaned `audio.wav` files without a corresponding `done` status entry. Exposed to the frontend via Tauri commands in `src-tauri` so `RecorderWidget` can request a real meeting directory instead of the `/tmp` placeholder from plan 06.

**Tech Stack:** Rust, `serde`/`serde_json`, `directories` crate, `chrono`

---

### Task 1: MeetingMeta/MeetingStatus in core + create_meeting in storage crate

**Files:**
- Create: `crates/meeting-notes-core/src/meeting.rs`
- Modify: `crates/meeting-notes-core/src/lib.rs`
- Modify: `crates/meeting-notes-core/Cargo.toml`
- Modify: `crates/meeting-notes-storage/src/lib.rs`
- Create: `crates/meeting-notes-storage/src/tests.rs`
- Modify: `crates/meeting-notes-storage/Cargo.toml`

- [ ] **Step 1: Define MeetingMeta and MeetingStatus in core**

```rust
// crates/meeting-notes-core/src/meeting.rs
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MeetingStatus {
    Recording,
    Transcribing,
    Summarizing,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMeta {
    pub id: String, // directory name, e.g. "2026-08-01_143000_team-sync"
    pub title: String,
    pub created_at: String, // ISO 8601
    pub duration_seconds: Option<u64>,
    pub status: MeetingStatus,
    pub used_system_audio: bool,
}

impl MeetingMeta {
    pub fn dir_path(&self, base: &Path) -> PathBuf {
        base.join("meetings").join(&self.id)
    }
}
```

Register in `crates/meeting-notes-core/src/lib.rs`: `pub mod meeting;`. Add core's own dependency: `cd crates/meeting-notes-core && cargo add serde --features derive` (skip if already added in plan 02).

- [ ] **Step 2: Write failing test for directory creation in the storage crate**

```rust
// crates/meeting-notes-storage/src/tests.rs
use super::*;
use meeting_notes_core::meeting::MeetingStatus;
use tempfile::tempdir;

#[test]
fn create_meeting_dir_creates_expected_path() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Team Sync").unwrap();
    assert!(meta.dir_path(base.path()).exists());
    assert_eq!(meta.status, MeetingStatus::Recording);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p meeting-notes-storage -- --nocapture`
Expected: FAIL — `create_meeting` not defined. Add dev-dependency: `cd crates/meeting-notes-storage && cargo add --dev tempfile`.

- [ ] **Step 4: Implement create_meeting in the storage crate**

```rust
// crates/meeting-notes-storage/src/lib.rs
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use std::path::Path;

fn slugify(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    slug.trim_matches('-').chars().take(30).collect()
}

pub fn create_meeting(base: &Path, title: &str) -> std::io::Result<MeetingMeta> {
    let now = chrono::Utc::now();
    let ts = now.format("%Y-%m-%d_%H%M%S").to_string();
    let slug = slugify(title);
    let id = if slug.is_empty() { ts.clone() } else { format!("{ts}_{slug}") };

    let meta = MeetingMeta {
        id,
        title: title.to_string(),
        created_at: now.to_rfc3339(),
        duration_seconds: None,
        status: MeetingStatus::Recording,
        used_system_audio: false,
    };

    std::fs::create_dir_all(meta.dir_path(base))?;
    Ok(meta)
}

#[cfg(test)]
mod tests;
```

Add dependencies from within `crates/meeting-notes-storage`: `cargo add chrono --features serde` and `cargo add meeting-notes-core --path ../meeting-notes-core` (if not already present from plan 01 Task 1).

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p meeting-notes-storage -- --nocapture`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-core/src crates/meeting-notes-core/Cargo.toml crates/meeting-notes-storage/src crates/meeting-notes-storage/Cargo.toml
git commit -m "feat: add MeetingMeta/MeetingStatus to core and create_meeting to storage crate"
```

---

### Task 2: index.json read/write

**Files:**
- Modify: `crates/meeting-notes-storage/src/lib.rs`
- Modify: `crates/meeting-notes-storage/src/tests.rs`

- [ ] **Step 1: Write failing test for index round-trip**

```rust
#[test]
fn saves_and_loads_index() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Standup").unwrap();
    append_to_index(base.path(), &meta).unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].id, meta.id);
}

#[test]
fn update_status_persists_change() {
    let base = tempdir().unwrap();
    let mut meta = create_meeting(base.path(), "Retro").unwrap();
    append_to_index(base.path(), &meta).unwrap();

    meta.status = MeetingStatus::Done;
    meta.duration_seconds = Some(1800);
    update_meeting(base.path(), &meta).unwrap();

    let index = load_index(base.path()).unwrap();
    assert_eq!(index[0].status, MeetingStatus::Done);
    assert_eq!(index[0].duration_seconds, Some(1800));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-storage -- --nocapture`
Expected: FAIL — `append_to_index`, `load_index`, `update_meeting` not defined.

- [ ] **Step 3: Implement index functions**

```rust
// crates/meeting-notes-storage/src/lib.rs (additions)
use std::path::PathBuf;

fn index_path(base: &Path) -> PathBuf {
    base.join("index.json")
}

pub fn load_index(base: &Path) -> std::io::Result<Vec<MeetingMeta>> {
    let path = index_path(base);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

fn save_index(base: &Path, index: &[MeetingMeta]) -> std::io::Result<()> {
    let contents = serde_json::to_string_pretty(index)?;
    std::fs::write(index_path(base), contents)
}

pub fn append_to_index(base: &Path, meta: &MeetingMeta) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    index.push(meta.clone());
    save_index(base, &index)
}

pub fn update_meeting(base: &Path, updated: &MeetingMeta) -> std::io::Result<()> {
    let mut index = load_index(base)?;
    if let Some(entry) = index.iter_mut().find(|m| m.id == updated.id) {
        *entry = updated.clone();
    }
    save_index(base, &index)
}
```

Add `cargo add serde_json` from within `crates/meeting-notes-storage` if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-storage -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-storage/src crates/meeting-notes-storage/Cargo.toml
git commit -m "feat: add index.json read/write for meeting metadata"
```

---

### Task 3: Tauri commands + orphaned recording detection

**Files:**
- Modify: `crates/meeting-notes-storage/src/lib.rs`
- Modify: `crates/meeting-notes-storage/Cargo.toml`
- Modify: `src-tauri/Cargo.toml` (confirm `meeting-notes-storage`/`meeting-notes-core` path dependencies, added in plan 01 Task 1)
- Create: `src-tauri/src/commands/storage_commands.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src/lib/storage.ts`
- Modify: `src/components/RecorderWidget.tsx`

- [ ] **Step 1: Add base_dir helper + orphan detection**

```rust
// crates/meeting-notes-storage/src/lib.rs (additions)
use meeting_notes_core::meeting::MeetingStatus;

pub fn base_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")
        .map(|dirs| dirs.data_dir().to_path_buf())
}

/// Meetings whose status never advanced past Recording — likely crashed/interrupted.
pub fn find_orphaned_meetings(base: &Path) -> std::io::Result<Vec<MeetingMeta>> {
    let index = load_index(base)?;
    Ok(index
        .into_iter()
        .filter(|m| m.status == MeetingStatus::Recording)
        .collect())
}
```

Add dependency from within `crates/meeting-notes-storage`: `cargo add directories`.

- [ ] **Step 2: Add Tauri commands**

```rust
// src-tauri/src/commands/storage_commands.rs
use meeting_notes_core::meeting::MeetingMeta;
use meeting_notes_storage::{
    append_to_index, base_dir, create_meeting, find_orphaned_meetings, update_meeting,
};

#[tauri::command]
pub fn create_new_meeting(title: String) -> Result<MeetingMeta, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meta = create_meeting(&base, &title).map_err(|e| e.to_string())?;
    append_to_index(&base, &meta).map_err(|e| e.to_string())?;
    Ok(meta)
}

#[tauri::command]
pub fn update_meeting_status(meeting: MeetingMeta) -> Result<(), String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    update_meeting(&base, &meeting).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_orphaned_meetings() -> Result<Vec<MeetingMeta>, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    find_orphaned_meetings(&base).map_err(|e| e.to_string())
}
```

Register the three commands in `main.rs`'s `generate_handler![]`.

- [ ] **Step 3: Add TypeScript wrapper**

```ts
// src/lib/storage.ts
import { invoke } from "@tauri-apps/api/core";

export interface MeetingMeta {
  id: string;
  title: string;
  created_at: string;
  duration_seconds: number | null;
  status: "Recording" | "Transcribing" | "Summarizing" | "Done" | "Failed";
  used_system_audio: boolean;
}

export const createNewMeeting = (title: string) =>
  invoke<MeetingMeta>("create_new_meeting", { title });

export const updateMeetingStatus = (meeting: MeetingMeta) =>
  invoke<void>("update_meeting_status", { meeting });

export const getOrphanedMeetings = () => invoke<MeetingMeta[]>("get_orphaned_meetings");
```

- [ ] **Step 4: Replace the /tmp placeholder in RecorderWidget with real meeting creation**

```tsx
// src/components/RecorderWidget.tsx (modify handleStart)
import { createNewMeeting, updateMeetingStatus, type MeetingMeta } from "@/lib/storage";

// inside RecorderWidget, replace meetingDirRef usage:
const currentMeetingRef = useRef<MeetingMeta | null>(null);

const handleStart = async () => {
  const meeting = await createNewMeeting(title);
  currentMeetingRef.current = meeting;
  const outputPath = `${await meetingsDataDir()}/meetings/${meeting.id}/audio.wav`;
  setElapsedSeconds(0);
  const usedSystemAudio = await startRecording(outputPath);
  setMicOnlyWarning(!usedSystemAudio);
  setState("recording");
};

const handleStop = async () => {
  await stopRecording();
  if (currentMeetingRef.current) {
    await updateMeetingStatus({
      ...currentMeetingRef.current,
      status: "Transcribing",
      duration_seconds: elapsedSeconds,
    });
  }
  setState("processing");
};
```

Remove the old `meetingsBaseDir` placeholder function; add a real `meetingsDataDir` that calls a new tiny Tauri command `get_data_dir` returning `base_dir()` as a string (add this command alongside the others in this task).

- [ ] **Step 5: Manual verification**

Run: `bun run tauri dev`, start and stop a recording.
Expected: `~/.local/share/meeting-notes/index.json` contains one entry with status `Transcribing` after stop, and the meeting directory contains `audio.wav`.

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-storage src-tauri/src/commands src-tauri/src/main.rs src/lib/storage.ts src/components/RecorderWidget.tsx
git commit -m "feat: wire recorder widget to real meeting storage and index"
```
