# macOS Audio Capture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Requires Plan 13 (macOS toolchain/permissions verified) and Plan 14 (platform-dispatch scaffolding in place) to be complete first.

**Goal:** Implement `meeting_notes_audio::macos::RecordingHandle` with the same public API as the Linux version (`start(path) -> (Self, bool)`, `stop()`, `output_path()`) — mic capture via `cpal`, system audio capture via ScreenCaptureKit, mixed into `audio.wav` via the existing platform-agnostic `mix_wav_files`.

**Architecture:** Two capture sources running concurrently during a recording: `cpal` opens the default input device and writes mic samples to a temp WAV via a callback-driven stream; a ScreenCaptureKit `SCStream` (accessed through the `screencapturekit` Rust crate) captures system audio frames to a second temp WAV. On `stop()`, both streams are torn down and mixed exactly as the Linux backend does. If ScreenCaptureKit setup fails (no permission, OS < 13, or the crate can't create a stream), the backend falls back to mic-only — mirroring the Linux "no monitor source" fallback.

**Tech Stack:** Rust, `cpal` (cross-platform audio I/O), `screencapturekit` crate (Rust bindings over ScreenCaptureKit), `hound`

---

### Task 1: Mic capture via cpal

**Files:**
- Create: `crates/meeting-notes-audio/src/macos.rs`
- Create: `crates/meeting-notes-audio/src/macos_tests.rs`
- Modify: `crates/meeting-notes-audio/Cargo.toml`
- Modify: `crates/meeting-notes-audio/src/lib.rs`

- [ ] **Step 1: Write failing test for mic-only capture lifecycle**

```rust
// crates/meeting-notes-audio/src/macos_tests.rs
use super::*;

#[test]
#[ignore] // requires real mic hardware + granted permission on the dev Mac (see Plan 13)
fn mic_capture_creates_output_file_after_stop() {
    let tmp = std::env::temp_dir().join(format!("mic-test-{}.wav", std::process::id()));
    let mut capture = MicCapture::start(&tmp).expect("should start mic capture");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    capture.stop().expect("should stop cleanly");
    assert!(tmp.exists(), "expected wav file to exist at {:?}", tmp);
    let _ = std::fs::remove_file(&tmp);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio --target-cpu native -- --ignored --nocapture` (on the dev Mac)
Expected: FAIL — `MicCapture` not defined. Add dependency: `cd crates/meeting-notes-audio && cargo add cpal`.

- [ ] **Step 3: Implement MicCapture using cpal**

```rust
// crates/meeting-notes-audio/src/macos.rs
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct MicCapture {
    stream: cpal::Stream,
    output_path: PathBuf,
}

impl MicCapture {
    pub fn start(output_path: &Path) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("no default input device found")?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("failed to get default input config: {e}"))?;

        let spec = WavSpec {
            channels: 1,
            sample_rate: config.sample_rate().0,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = Arc::new(Mutex::new(
            WavWriter::create(output_path, spec).map_err(|e| e.to_string())?,
        ));

        let writer_clone = writer.clone();
        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    let mut w = writer_clone.lock().unwrap();
                    for &sample in data {
                        let clamped = (sample * i16::MAX as f32) as i16;
                        let _ = w.write_sample(clamped);
                    }
                },
                move |err| eprintln!("cpal input stream error: {err}"),
                None,
            )
            .map_err(|e| format!("failed to build input stream: {e}"))?;

        stream.play().map_err(|e| e.to_string())?;

        Ok(MicCapture {
            stream,
            output_path: output_path.to_path_buf(),
        })
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.stream.pause().map_err(|e| e.to_string())
        // WavWriter finalizes on drop; the Arc<Mutex<WavWriter>> inside the closure
        // is dropped when the stream is dropped after this call returns.
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

#[cfg(test)]
mod macos_tests;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the dev Mac, with mic permission already granted per Plan 13)
Expected: PASS, WAV file created and non-empty.

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src crates/meeting-notes-audio/Cargo.toml
git commit -m "feat: add macOS mic capture via cpal"
```

---

### Task 2: System audio capture via ScreenCaptureKit

**Files:**
- Modify: `crates/meeting-notes-audio/src/macos.rs`
- Modify: `crates/meeting-notes-audio/src/macos_tests.rs`
- Modify: `crates/meeting-notes-audio/Cargo.toml`

- [ ] **Step 1: Write failing test for system audio capture availability check**

```rust
#[test]
#[ignore] // requires Screen Recording permission granted (see Plan 13 Task 2)
fn system_audio_capture_is_available() {
    assert!(
        system_audio_available(),
        "expected ScreenCaptureKit audio capture to be available on this Mac \
         (requires macOS 13+ and granted Screen Recording permission — see Plan 13)"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the dev Mac)
Expected: FAIL — `system_audio_available` not defined. Add dependency: `cd crates/meeting-notes-audio && cargo add screencapturekit`.

- [ ] **Step 3: Implement SystemAudioCapture**

```rust
// crates/meeting-notes-audio/src/macos.rs (additions)
use screencapturekit::{
    shareable_content::SCShareableContent,
    stream::{
        configuration::SCStreamConfiguration, content_filter::SCContentFilter, SCStream,
    },
};

pub fn system_audio_available() -> bool {
    SCShareableContent::get().is_ok()
}

pub struct SystemAudioCapture {
    stream: SCStream,
    output_path: PathBuf,
}

impl SystemAudioCapture {
    pub fn start(output_path: &Path) -> Result<Self, String> {
        let content = SCShareableContent::get().map_err(|e| format!("{e:?}"))?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or("no display found for system audio capture")?;

        let filter = SCContentFilter::new().with_display_excluding_windows(&display, &[]);
        let mut config = SCStreamConfiguration::new();
        config.set_captures_audio(true);

        let writer = Arc::new(Mutex::new(
            WavWriter::create(
                output_path,
                WavSpec {
                    channels: 1,
                    sample_rate: 16000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .map_err(|e| e.to_string())?,
        ));

        let stream = SCStream::new(filter, config);
        let writer_clone = writer.clone();
        stream.add_audio_output_handler(move |audio_buffer| {
            let mut w = writer_clone.lock().unwrap();
            for sample in audio_buffer.samples() {
                let _ = w.write_sample((*sample * i16::MAX as f32) as i16);
            }
        });
        stream.start().map_err(|e| format!("{e:?}"))?;

        Ok(SystemAudioCapture {
            stream,
            output_path: output_path.to_path_buf(),
        })
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.stream.stop().map_err(|e| format!("{e:?}"))
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}
```

Note for the implementing agent: the `screencapturekit` crate's exact API surface (method names on `SCStream`, `SCContentFilter`, audio buffer sample access) should be checked against whatever version resolves via `cargo add` — Rust bindings over Apple frameworks evolve; treat the method names above as the intended shape, not a guaranteed-exact API, and adjust to match the installed crate version's actual signatures, recording any deviation in `docs/superpowers/specs/environment.md`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the dev Mac, with Screen Recording permission granted per Plan 13 Task 2)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src crates/meeting-notes-audio/Cargo.toml
git commit -m "feat: add macOS system audio capture via ScreenCaptureKit"
```

---

### Task 3: Unified RecordingHandle with mic-only fallback and mixing

**Files:**
- Modify: `crates/meeting-notes-audio/src/macos.rs`
- Modify: `crates/meeting-notes-audio/src/macos_tests.rs`

- [ ] **Step 1: Write failing test for the unified handle, mirroring the Linux test shape**

```rust
#[test]
#[ignore] // requires mic + Screen Recording permission on the dev Mac
fn start_creates_mixed_output_file_after_stop() {
    let tmp = std::env::temp_dir().join(format!("macos-mix-test-{}.wav", std::process::id()));
    let (mut handle, used_system_audio) =
        RecordingHandle::start(&tmp).expect("should start recording");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    handle.stop().expect("should stop cleanly");
    assert!(tmp.exists());
    // used_system_audio reflects whatever this Mac's actual permission state is —
    // just confirm the flag is consistent with system_audio_available().
    assert_eq!(used_system_audio, system_audio_available());
    let _ = std::fs::remove_file(&tmp);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the dev Mac)
Expected: FAIL — `RecordingHandle` (macOS version) not defined.

- [ ] **Step 3: Implement the unified RecordingHandle**

```rust
// crates/meeting-notes-audio/src/macos.rs (additions)
use crate::mix_wav_files;

pub struct RecordingHandle {
    mic: MicCapture,
    system: Option<SystemAudioCapture>,
    mic_path: PathBuf,
    system_path: Option<PathBuf>,
    final_output_path: PathBuf,
}

impl RecordingHandle {
    pub fn start(final_output_path: &Path) -> Result<(Self, bool), String> {
        let mic_path = final_output_path.with_extension("mic.wav");
        let mic = MicCapture::start(&mic_path)?;

        let (system, system_path, used_system_audio) = if system_audio_available() {
            let sys_path = final_output_path.with_extension("system.wav");
            match SystemAudioCapture::start(&sys_path) {
                Ok(capture) => (Some(capture), Some(sys_path), true),
                Err(_) => (None, None, false), // permission revoked mid-session, etc.
            }
        } else {
            (None, None, false)
        };

        Ok((
            RecordingHandle {
                mic,
                system,
                mic_path,
                system_path,
                final_output_path: final_output_path.to_path_buf(),
            },
            used_system_audio,
        ))
    }

    pub fn stop(&mut self) -> Result<(), String> {
        self.mic.stop()?;
        if let Some(system) = &mut self.system {
            system.stop()?;
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

This mirrors the Linux `RecordingHandle` in plan 05 exactly in shape (`start(path) -> (Self, bool)`, `stop() -> Result<(), String>`, `output_path()`), so `src-tauri`'s `recording_commands.rs` needs zero changes to work with either platform.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the dev Mac)
Expected: PASS.

- [ ] **Step 5: Manual verification through the actual app**

Run: `bun run tauri dev` (on the dev Mac), start a recording, play some audio + speak, stop.
Expected: `audio.wav` contains both your mic and the system audio mixed, exactly matching the Linux behavior from plans 04–05 — `startRecording()`'s returned boolean reflects whether ScreenCaptureKit capture succeeded.

- [ ] **Step 6: Commit**

```bash
git add crates/meeting-notes-audio/src
git commit -m "feat: unify macOS mic + system audio capture into RecordingHandle with fallback"
```
