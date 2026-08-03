# Whisper.cpp Transcription Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run whisper.cpp on the recorded `audio.wav` to produce `transcript.json` (timestamped segments) and `transcript.txt`, as an async Tauri command wired to the widget's Processing state.

> **Prerequisite:** Plan 00 Task 3 must be complete. Use the exact whisper.cpp binary path, model filename pattern, and JSON output shape recorded in `docs/superpowers/specs/environment.md`. If the actual JSON shape differs from the `transcription[].offsets.from/to` / `.text` structure assumed in `parse_whisper_json` below, adjust the parsing to match what Plan 00 actually observed — do not assume the shape below is correct without checking.

**Architecture:** `TranscriptSegment`/`TranscriptResult` are shared domain types defined in `meeting-notes-core`. The `meeting-notes-transcription` crate shells out to a `whisper-cli` (or `main`, depending on the whisper.cpp build) binary located via a configurable path, using its `--output-json` flag to get structured segment output, which is mapped into the core `TranscriptSegment` schema and flattened to plain text. `src-tauri` runs this via `tauri::async_runtime::spawn_blocking` so it doesn't block the UI thread, emitting a Tauri event on completion that the frontend listens for.

**Tech Stack:** Rust, `std::process::Command`, `serde_json`, Tauri events

---

### Task 1: TranscriptSegment/TranscriptResult in core + run_whisper in transcription crate

**Files:**
- Create: `crates/meeting-notes-core/src/transcript.rs`
- Modify: `crates/meeting-notes-core/src/lib.rs`
- Modify: `crates/meeting-notes-transcription/src/lib.rs`
- Create: `crates/meeting-notes-transcription/src/tests.rs`
- Modify: `crates/meeting-notes-transcription/Cargo.toml`

- [ ] **Step 1: Define TranscriptSegment/TranscriptResult in core**

```rust
// crates/meeting-notes-core/src/transcript.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptResult {
    pub segments: Vec<TranscriptSegment>,
}
```

Register in `crates/meeting-notes-core/src/lib.rs`: `pub mod transcript;`

- [ ] **Step 2: Write failing test for whisper.cpp invocation on a sample file**

```rust
// crates/meeting-notes-transcription/src/tests.rs
use super::*;

#[test]
#[ignore] // requires a bundled whisper.cpp binary + model on the dev machine
fn transcribes_a_short_sample_wav() {
    let sample = std::path::Path::new("test-fixtures/hello.wav");
    let result = run_whisper(sample, "base.en").expect("transcription should succeed");
    assert!(!result.segments.is_empty());
    assert!(result.segments[0].text.to_lowercase().contains("hello"));
}
```

Note: requires a `test-fixtures/hello.wav` sample file (a few seconds of clear speech saying "hello") added at the workspace root for this ignored test.

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p meeting-notes-transcription -- --ignored --nocapture`
Expected: FAIL — `run_whisper` not defined.

- [ ] **Step 4: Implement run_whisper**

```rust
// crates/meeting-notes-transcription/src/lib.rs
use meeting_notes_core::transcript::{TranscriptResult, TranscriptSegment};
use std::path::Path;
use std::process::Command;

/// Locates the bundled whisper.cpp CLI binary. Checks an env var override first,
/// then falls back to a path relative to the app's resource directory.
fn whisper_binary_path() -> String {
    std::env::var("MEETING_NOTES_WHISPER_BIN").unwrap_or_else(|_| "whisper-cli".to_string())
}

pub fn run_whisper(audio_path: &Path, model: &str) -> Result<TranscriptResult, String> {
    let model_path = format!("models/ggml-{model}.bin");
    let output_base = audio_path.with_extension(""); // whisper.cpp appends .json itself

    let status = Command::new(whisper_binary_path())
        .arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(audio_path)
        .arg("-oj") // output json
        .arg("-of")
        .arg(&output_base)
        .status()
        .map_err(|e| format!("failed to spawn whisper.cpp: {e}"))?;

    if !status.success() {
        return Err(format!("whisper.cpp exited with status {status}"));
    }

    let json_path = output_base.with_extension("json");
    let contents = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("failed to read whisper output: {e}"))?;
    parse_whisper_json(&contents)
}

fn parse_whisper_json(contents: &str) -> Result<TranscriptResult, String> {
    let raw: serde_json::Value =
        serde_json::from_str(contents).map_err(|e| format!("invalid whisper json: {e}"))?;
    let transcription = raw["transcription"]
        .as_array()
        .ok_or("missing 'transcription' array in whisper output")?;

    let segments = transcription
        .iter()
        .map(|seg| TranscriptSegment {
            start_time: seg["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0,
            end_time: seg["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0,
            text: seg["text"].as_str().unwrap_or("").trim().to_string(),
        })
        .collect();

    Ok(TranscriptResult { segments })
}

#[cfg(test)]
mod tests;
```

This module is the crate root (`lib.rs`) — no separate registration needed. Add dependencies from within `crates/meeting-notes-transcription`: `cargo add serde_json` and `cargo add meeting-notes-core --path ../meeting-notes-core` (if not already present from plan 01 Task 1).

- [ ] **Step 5: Run test on real hardware to verify it passes**

Run: `cargo test -p meeting-notes-transcription -- --ignored --nocapture` (with whisper.cpp binary and `base.en` model installed)
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-core/src crates/meeting-notes-transcription/src crates/meeting-notes-transcription/Cargo.toml
git commit -m "feat: add TranscriptSegment/TranscriptResult to core, run_whisper to transcription crate"
```

---

### Task 2: Persist transcript.json and transcript.txt

**Files:**
- Modify: `crates/meeting-notes-transcription/src/lib.rs`
- Modify: `crates/meeting-notes-transcription/src/tests.rs`

- [ ] **Step 1: Write failing test for saving transcript files**

```rust
#[test]
fn saves_transcript_json_and_txt() {
    let dir = std::env::temp_dir().join(format!("transcript-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let result = TranscriptResult {
        segments: vec![
            TranscriptSegment { start_time: 0.0, end_time: 1.5, text: "Hello team.".into() },
            TranscriptSegment { start_time: 1.5, end_time: 3.0, text: "Let's get started.".into() },
        ],
    };

    save_transcript(&dir, &result).unwrap();

    let json = std::fs::read_to_string(dir.join("transcript.json")).unwrap();
    assert!(json.contains("Hello team."));

    let txt = std::fs::read_to_string(dir.join("transcript.txt")).unwrap();
    assert_eq!(txt, "Hello team. Let's get started.");

    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-transcription saves_transcript_json_and_txt -- --nocapture`
Expected: FAIL — `save_transcript` not defined.

- [ ] **Step 3: Implement save_transcript**

```rust
// crates/meeting-notes-transcription/src/lib.rs (additions)
use std::path::PathBuf;

pub fn save_transcript(meeting_dir: &Path, result: &TranscriptResult) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(&result.segments)?;
    std::fs::write(meeting_dir.join("transcript.json"), json)?;

    let plain_text = result
        .segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(meeting_dir.join("transcript.txt"), plain_text)?;
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-transcription saves_transcript_json_and_txt -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-transcription/src
git commit -m "feat: persist transcript.json and transcript.txt to meeting directory"
```

---

### Task 3: Async Tauri command + Processing state wiring

**Files:**
- Modify: `src-tauri/Cargo.toml` (confirm `meeting-notes-transcription`/`meeting-notes-storage`/`meeting-notes-core` path dependencies, added in plan 01 Task 1)
- Create: `src-tauri/src/commands/transcription_commands.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src/lib/transcription.ts`
- Modify: `src/components/RecorderWidget.tsx`

- [ ] **Step 1: Implement async command that emits progress events**

```rust
// src-tauri/src/commands/transcription_commands.rs
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_storage::{base_dir, update_meeting};
use meeting_notes_transcription::{run_whisper, save_transcript};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn transcribe_meeting(
    app: AppHandle,
    meeting: MeetingMeta,
    whisper_model: String,
) -> Result<(), String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meeting_dir = meeting.dir_path(&base);
    let audio_path = meeting_dir.join("audio.wav");

    let meeting_clone = meeting.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_whisper(&audio_path, &whisper_model)
    })
    .await
    .map_err(|e| e.to_string())??;

    save_transcript(&meeting_dir, &result).map_err(|e| e.to_string())?;

    let mut updated = meeting_clone;
    updated.status = MeetingStatus::Summarizing;
    update_meeting(&base, &updated).map_err(|e| e.to_string())?;

    app.emit("transcription-complete", &updated)
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

Register `transcribe_meeting` in `generate_handler![]`.

- [ ] **Step 2: Add TypeScript wrapper with event listener helper**

```ts
// src/lib/transcription.ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MeetingMeta } from "@/lib/storage";

export const transcribeMeeting = (meeting: MeetingMeta, whisperModel: string) =>
  invoke<void>("transcribe_meeting", { meeting, whisperModel });

export const onTranscriptionComplete = (callback: (meeting: MeetingMeta) => void) =>
  listen<MeetingMeta>("transcription-complete", (event) => callback(event.payload));
```

- [ ] **Step 3: Wire into RecorderWidget's Processing state**

```tsx
// src/components/RecorderWidget.tsx (additions)
import { transcribeMeeting, onTranscriptionComplete } from "@/lib/transcription";
import { getConfig } from "@/lib/config";

// inside handleStop, after setState("processing"):
useEffect(() => {
  if (state !== "processing" || !currentMeetingRef.current) return;

  let unlisten: (() => void) | undefined;
  (async () => {
    unlisten = await onTranscriptionComplete((updated) => {
      currentMeetingRef.current = updated;
      // Summary generation wired in a later plan; for now just log.
      console.log("Transcription complete", updated);
    });
    const config = await getConfig();
    await transcribeMeeting(currentMeetingRef.current!, config.whisper_model ?? "base.en");
  })();

  return () => unlisten?.();
}, [state]);

// Replace the processing placeholder render:
if (state === "processing") {
  return (
    <div className="flex flex-col gap-2 h-full justify-center items-center text-sm text-muted-foreground">
      <span>Transcribing…</span>
    </div>
  );
}
```

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`, record a short meeting, stop.
Expected: widget shows "Transcribing…", and after whisper.cpp finishes, `meeting_dir/transcript.json` and `transcript.txt` exist, console logs the updated meeting with status `Summarizing`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands src-tauri/src/main.rs src/lib/transcription.ts src/components/RecorderWidget.tsx
git commit -m "feat: wire async transcription command into processing state"
```
