# Audio Capture (System Audio + Mixing) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extend recording to also capture system audio (the PipeWire monitor source) alongside mic input, mixed into a single WAV, with graceful mic-only fallback when no monitor source exists.

> **Prerequisite:** Plan 00 Task 2 must be complete. If the standalone smoke test found no monitor source on this machine, treat the mic-only fallback path as the expected primary behavior here (not an edge case) and prioritize testing that path over the dual-stream path. Use the exact monitor source naming pattern recorded in `docs/superpowers/specs/environment.md` — `find_monitor_source()` below assumes `<sink>.monitor`, which is standard but should be confirmed against what Plan 00 actually found.

**Architecture:** Detect the default sink's monitor source via `pactl` (or `pw-cli`), and if found, run a second `pw-record` process against it in parallel with the mic recording. Both write separate temp WAVs; on stop, mix them sample-by-sample into the final `audio.wav` using `hound`. If no monitor source is found, skip straight to mic-only (already built in plan 04) and surface a flag the frontend can use to show the warning badge.

**Tech Stack:** Rust, `pactl`/`pw-record` (system binaries), `hound`

---

### Task 1: Detect system audio monitor source

**Files:**
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Modify: `crates/meeting-notes-audio/src/tests.rs`

- [x] **Step 1: Write failing test for monitor source detection**

```rust
#[test]
#[ignore] // requires real PipeWire/PulseAudio on the dev machine
fn detects_a_monitor_source_when_present() {
    let result = find_monitor_source();
    // On a normal desktop with an active sink, this should find something.
    assert!(result.is_some(), "expected a monitor source to be found");
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture`
Expected: FAIL — `find_monitor_source` not defined.

- [x] **Step 3: Implement detection via pactl**

```rust
// crates/meeting-notes-audio/src/lib.rs (additions)
use std::process::Command;

/// Returns the name of the default sink's monitor source (e.g. "alsa_output...monitor"),
/// or None if PipeWire/PulseAudio tooling is unavailable or no sink exists.
pub fn find_monitor_source() -> Option<String> {
    let output = Command::new("pactl")
        .args(["get-default-sink"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sink = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sink.is_empty() {
        return None;
    }
    Some(format!("{}.monitor", sink))
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on Ubuntu dev machine)
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src
git commit -m "feat: detect PipeWire/PulseAudio monitor source for system audio"
```

---

### Task 2: Dual-stream capture with mixing on stop

**Files:**
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Modify: `crates/meeting-notes-audio/src/tests.rs`

- [x] **Step 1: Write failing test for mixing two WAVs**

```rust
#[test]
fn mixes_two_equal_length_wavs() {
    let dir = std::env::temp_dir().join(format!("mix-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.wav");
    let b = dir.join("b.wav");
    write_test_wav(&a, &[1000, 2000, 3000]);
    write_test_wav(&b, &[500, 500, 500]);
    let out = dir.join("mixed.wav");

    mix_wav_files(&a, &b, &out).expect("mix should succeed");

    let mut reader = hound::WavReader::open(&out).unwrap();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(samples, vec![1500, 2500, 3500]);

    let _ = std::fs::remove_dir_all(&dir);
}

fn write_test_wav(path: &std::path::Path, samples: &[i16]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for s in samples {
        writer.write_sample(*s).unwrap();
    }
    writer.finalize().unwrap();
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio mixes_two_equal_length_wavs -- --nocapture`
Expected: FAIL — `mix_wav_files` not defined.

- [x] **Step 3: Implement mixing with clipping-safe saturation**

```rust
// crates/meeting-notes-audio/src/lib.rs (additions)
use std::path::Path;

pub fn mix_wav_files(a_path: &Path, b_path: &Path, out_path: &Path) -> Result<(), String> {
    let mut a_reader = hound::WavReader::open(a_path).map_err(|e| e.to_string())?;
    let mut b_reader = hound::WavReader::open(b_path).map_err(|e| e.to_string())?;
    let spec = a_reader.spec();

    let a_samples: Vec<i16> = a_reader.samples::<i16>().filter_map(|s| s.ok()).collect();
    let b_samples: Vec<i16> = b_reader.samples::<i16>().filter_map(|s| s.ok()).collect();
    let len = a_samples.len().max(b_samples.len());

    let mut writer = hound::WavWriter::create(out_path, spec).map_err(|e| e.to_string())?;
    for i in 0..len {
        let a = *a_samples.get(i).unwrap_or(&0) as i32;
        let b = *b_samples.get(i).unwrap_or(&0) as i32;
        let mixed = (a + b).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        writer.write_sample(mixed).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}
```

Add `hound` dependency if not already present: `cd crates/meeting-notes-audio && cargo add hound`.

- [x] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio mixes_two_equal_length_wavs -- --nocapture`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src
git commit -m "feat: mix two WAV streams with clipping-safe saturation"
```

---

### Task 3: Wire dual-stream capture + mic-only fallback into recording commands

**Files:**
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Modify: `src-tauri/src/commands/recording_commands.rs`
- Modify: `src/lib/recording.ts`

- [x] **Step 1: Extend RecordingHandle to optionally track a system-audio child**

```rust
// crates/meeting-notes-audio/src/lib.rs (modify RecordingHandle)
pub struct RecordingHandle {
    mic_child: Child,
    system_child: Option<Child>,
    mic_path: PathBuf,
    system_path: Option<PathBuf>,
    final_output_path: PathBuf,
}

impl RecordingHandle {
    pub fn start(final_output_path: &Path) -> std::io::Result<(Self, bool)> {
        let mic_path = final_output_path.with_extension("mic.wav");
        let mic_child = Command::new("pw-record")
            .args(["--channels=1", "--rate=16000"])
            .arg(&mic_path)
            .spawn()?;

        let (system_child, system_path, used_system_audio) = match find_monitor_source() {
            Some(source) => {
                let sys_path = final_output_path.with_extension("system.wav");
                let child = Command::new("pw-record")
                    .args(["--channels=1", "--rate=16000", "--target"])
                    .arg(&source)
                    .arg(&sys_path)
                    .spawn()?;
                (Some(child), Some(sys_path), true)
            }
            None => (None, None, false),
        };

        Ok((
            RecordingHandle {
                mic_child,
                system_child,
                mic_path,
                system_path,
                final_output_path: final_output_path.to_path_buf(),
            },
            used_system_audio,
        ))
    }

    pub fn stop(&mut self) -> Result<(), String> {
        unsafe { libc::kill(self.mic_child.id() as i32, libc::SIGTERM) };
        self.mic_child.wait().map_err(|e| e.to_string())?;
        if let Some(child) = &mut self.system_child {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            child.wait().map_err(|e| e.to_string())?;
        }
        match &self.system_path {
            Some(sys_path) => mix_wav_files(&self.mic_path, sys_path, &self.final_output_path)?,
            None => {
                std::fs::rename(&self.mic_path, &self.final_output_path)
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn output_path(&self) -> &Path {
        &self.final_output_path
    }
}
```

Remove the old `start_mic` in favor of `start`; update the mic-only test from plan 04 to call `RecordingHandle::start` and assert on the returned `used_system_audio` bool.

- [x] **Step 2: Update Tauri commands to surface the fallback flag**

```rust
// src-tauri/src/commands/recording_commands.rs (modify start_recording)
#[tauri::command]
pub fn start_recording(
    state: State<RecordingState>,
    output_path: String,
) -> Result<bool, String> {
    let path = PathBuf::from(output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let (handle, used_system_audio) =
        RecordingHandle::start(&path).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(handle);
    Ok(used_system_audio)
}
```

Update `stop_recording` to call the new `stop()` signature (`Result<(), String>` instead of `std::io::Result`).

- [x] **Step 3: Update TypeScript wrapper's return type**

```ts
// src/lib/recording.ts
export const startRecording = (outputPath: string) =>
  invoke<boolean>("start_recording", { outputPath }); // returns usedSystemAudio
```

- [x] **Step 4: Manual verification**

Run: `bun run tauri dev`, play audio/video with sound while recording, call `startRecording` then `stopRecording` after a few seconds.
Expected: mixed `audio.wav` contains both your mic input and the played-back system audio audibly. Returned boolean is `true` when a monitor source exists.

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src src-tauri/src/commands/recording_commands.rs src/lib/recording.ts
git commit -m "feat: capture and mix system audio with mic, with graceful fallback"
```
