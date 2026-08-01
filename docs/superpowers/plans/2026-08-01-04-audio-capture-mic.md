# Audio Capture (Mic Only) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Capture microphone audio via PipeWire and write it to a WAV file, exposed as Tauri `start_recording`/`stop_recording` commands.

> **Prerequisite:** Plan 00 Task 2 must be complete. Use the exact `pw-record` invocation and any device-specific flags recorded in `docs/superpowers/specs/environment.md` — if the standalone smoke test needed a non-default source or extra flags, `RecordingHandle::start_mic` below must match that, not the generic command as written.

**Architecture:** Shell out to `pw-record` (simpler, more reliable v1 than the `pipewire-rs` crate per the design doc's stated fallback) targeting the default mic source, writing directly to a WAV file at a path the caller provides. A `RecordingHandle` wraps the child process so it can be terminated cleanly on stop.

**Tech Stack:** Rust, `std::process::Command`, `pw-record` (system binary), `hound` (for WAV validation in tests)

---

### Task 1: RecordingHandle wrapper around pw-record

**Files:**
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Create: `crates/meeting-notes-audio/src/tests.rs`
- Modify: `crates/meeting-notes-audio/Cargo.toml`

- [x] **Step 1: Write failing test for handle lifecycle**

```rust
// crates/meeting-notes-audio/src/tests.rs
use super::*;
use std::path::PathBuf;

#[test]
fn start_creates_output_file_after_stop() {
    let tmp = std::env::temp_dir().join(format!("mic-test-{}.wav", std::process::id()));
    let mut handle = RecordingHandle::start_mic(&tmp).expect("should start recording");
    std::thread::sleep(std::time::Duration::from_millis(500));
    handle.stop().expect("should stop cleanly");
    assert!(tmp.exists(), "expected wav file to exist at {:?}", tmp);
    let _ = std::fs::remove_file(&tmp);
}
```

Note: this test requires a real PipeWire mic source and will only run meaningfully on the target Ubuntu dev machine — mark with `#[ignore]` if running in CI without audio hardware, and document that it must be run manually with `cargo test -- --ignored` on real hardware.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture`
Expected: FAIL — `RecordingHandle` not defined.

- [x] **Step 3: Implement RecordingHandle**

```rust
// crates/meeting-notes-audio/src/lib.rs
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

pub struct RecordingHandle {
    child: Child,
    output_path: PathBuf,
}

impl RecordingHandle {
    /// Starts recording default mic input to `output_path` as a WAV file via pw-record.
    pub fn start_mic(output_path: &Path) -> std::io::Result<Self> {
        let child = Command::new("pw-record")
            .arg("--channels=1")
            .arg("--rate=16000")
            .arg(output_path)
            .spawn()?;
        Ok(RecordingHandle {
            child,
            output_path: output_path.to_path_buf(),
        })
    }

    /// Stops the recording by sending SIGTERM so pw-record finalizes the WAV file.
    pub fn stop(&mut self) -> std::io::Result<()> {
        // pw-record needs a graceful signal (not kill -9) to write valid WAV headers.
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        self.child.wait()?;
        Ok(())
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

#[cfg(test)]
mod tests;
```

Add `libc` dependency from within the crate: `cd crates/meeting-notes-audio && cargo add libc`. This module is the crate root (`lib.rs`), so no separate `mod audio;` registration is needed — other crates will reference it as `meeting_notes_audio::RecordingHandle`.

- [x] **Step 4: Run test on real hardware to verify it passes**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the Ubuntu dev machine with a mic)
Expected: PASS, WAV file created and non-empty.

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src crates/meeting-notes-audio/Cargo.toml
git commit -m "feat: add mic-only recording via pw-record"
```

---

### Task 2: Tauri commands start_recording / stop_recording

**Files:**
- Modify: `src-tauri/Cargo.toml` (confirm `meeting-notes-audio` path dependency, added in plan 01 Task 1)
- Create: `src-tauri/src/commands/recording_commands.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src/lib/recording.ts`

- [x] **Step 1: Implement commands with app-managed state**

```rust
// src-tauri/src/commands/recording_commands.rs
use meeting_notes_audio::RecordingHandle;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct RecordingState(pub Mutex<Option<RecordingHandle>>);

#[tauri::command]
pub fn start_recording(
    state: State<RecordingState>,
    output_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let handle = RecordingHandle::start_mic(&path).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_recording(state: State<RecordingState>) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    let mut handle = guard.take().ok_or("no active recording")?;
    handle.stop().map_err(|e| e.to_string())?;
    Ok(handle.output_path().to_string_lossy().to_string())
}
```

Register `RecordingState(Mutex::new(None))` via `.manage(...)` in `main.rs`'s builder, and add both commands to `generate_handler![]`.

- [x] **Step 2: Add TypeScript wrapper**

```ts
// src/lib/recording.ts
import { invoke } from "@tauri-apps/api/core";

export const startRecording = (outputPath: string) =>
  invoke<void>("start_recording", { outputPath });

export const stopRecording = () => invoke<string>("stop_recording");
```

- [x] **Step 3: Manual verification**

Run: `bun run tauri dev`, call `startRecording("/tmp/test-meeting/audio.wav")` from devtools console, speak into mic for a few seconds, call `stopRecording()`.
Expected: `/tmp/test-meeting/audio.wav` exists and plays back your voice (verify with `aplay /tmp/test-meeting/audio.wav`).

- [x] **Step 4: Commit**

```bash
git add src-tauri/src/commands src-tauri/src/main.rs src/lib/recording.ts
git commit -m "feat: expose start/stop mic recording as Tauri commands"
```
