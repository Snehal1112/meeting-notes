# Cross-Platform Audio Facade Refactor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Run this after Plans 04–05 (existing Linux implementation) and before Plan 15 (macOS implementation).

**Goal:** Move the existing PipeWire-based `RecordingHandle` (built in plans 04–05) into a `linux` submodule behind `#[cfg(target_os = "linux")]`, and introduce a platform-dispatching facade in `lib.rs`, so a `macos` submodule can be added in Plan 15 without touching any Linux-specific code or any of its call sites in `src-tauri`.

**Architecture:** `crates/meeting-notes-audio/src/lib.rs` becomes a thin facade: it re-exports whichever platform module's `RecordingHandle` matches `target_os` via `#[cfg]`-gated `pub use`. `linux.rs` gets the exact code already written in plans 04–05, verbatim — this is a pure move, not a rewrite, so existing tests keep passing unchanged. `mix_wav_files` (plan 05) stays in `lib.rs` since it's already platform-agnostic (operates on WAV files, not capture internals) and both platform backends will use it.

**Tech Stack:** Rust, `#[cfg(target_os = ...)]`

---

### Task 1: Extract Linux code into linux.rs, unchanged

**Files:**
- Create: `crates/meeting-notes-audio/src/linux.rs`
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Modify: `crates/meeting-notes-audio/src/tests.rs` → split into `linux_tests.rs`

- [ ] **Step 1: Move RecordingHandle and its Linux-specific helpers into linux.rs**

Cut everything from `crates/meeting-notes-audio/src/lib.rs` that is Linux-specific (the `RecordingHandle` struct, its `impl` block including `start`/`stop`/`output_path`, and `find_monitor_source`) into a new file:

```rust
// crates/meeting-notes-audio/src/linux.rs
// (paste verbatim from lib.rs — RecordingHandle struct, impl block, find_monitor_source)
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

pub struct RecordingHandle {
    mic_child: Child,
    system_child: Option<Child>,
    mic_path: PathBuf,
    system_path: Option<PathBuf>,
    final_output_path: PathBuf,
}

impl RecordingHandle {
    pub fn start(final_output_path: &Path) -> std::io::Result<(Self, bool)> {
        // ... unchanged from plan 05 Task 3
        todo!("paste unchanged implementation from plan 05")
    }

    pub fn stop(&mut self) -> Result<(), String> {
        // ... unchanged from plan 05 Task 3
        todo!("paste unchanged implementation from plan 05")
    }

    pub fn output_path(&self) -> &Path {
        &self.final_output_path
    }
}

pub fn find_monitor_source() -> Option<String> {
    // ... unchanged from plan 05 Task 1
    todo!("paste unchanged implementation from plan 05")
}
```

Note for the implementing agent: this step is a literal cut-and-paste of the code already written and tested in plans 04–05 — do not modify the logic. The `todo!()` placeholders above exist only because this plan file doesn't repeat that already-written code in full; copy it from the actual `lib.rs` in the repo.

- [ ] **Step 2: Rename the test file and update its module path**

Rename `crates/meeting-notes-audio/src/tests.rs` to `crates/meeting-notes-audio/src/linux_tests.rs`. Its content (from plans 04–05) is unchanged — it already tests via `use super::*;`, and `super` will now correctly resolve to `linux.rs` once the module registration in Step 3 is in place.

- [ ] **Step 3: Update lib.rs to a thin dispatching facade**

```rust
// crates/meeting-notes-audio/src/lib.rs
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{find_monitor_source, RecordingHandle};

#[cfg(target_os = "linux")]
#[cfg(test)]
mod linux_tests;

// mix_wav_files stays here — platform-agnostic, used by both backends.
use std::path::Path;

pub fn mix_wav_files(a_path: &Path, b_path: &Path, out_path: &Path) -> Result<(), String> {
    // ... unchanged from plan 05 Task 2
    todo!("paste unchanged implementation from plan 05")
}
```

Add `mod linux;` include of `find_monitor_source` inside `linux.rs` itself with `pub(crate) fn find_monitor_source() -> Option<String>` — keep it re-exported as `pub use linux::find_monitor_source` only if it's called from outside the crate; otherwise make it private to `linux.rs` since only `linux::RecordingHandle::start` uses it.

- [ ] **Step 4: Run the full existing test suite to confirm nothing broke**

Run: `cargo test -p meeting-notes-audio -- --ignored --nocapture` (on the Linux dev machine)
Expected: all tests from plans 04–05 (`start_creates_output_file_after_stop`, `detects_a_monitor_source_when_present`, `mixes_two_equal_length_wavs`) still PASS — this refactor must not change behavior.

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src
git commit -m "refactor: extract Linux audio capture into linux submodule behind cfg(target_os)"
```

---

### Task 2: Confirm src-tauri call sites are unaffected

**Files:**
- Modify: `src-tauri/src/commands/recording_commands.rs` (verification only — likely no changes needed)

- [ ] **Step 1: Re-read the existing recording_commands.rs from plan 05 Task 3**

Confirm it imports `use meeting_notes_audio::RecordingHandle;` and calls `RecordingHandle::start(...)` / `.stop()` / `.output_path()` — all public API preserved unchanged by this refactor, so no code changes should be needed here.

- [ ] **Step 2: Build the full workspace to confirm no compile errors ripple upward**

Run: `cargo build --workspace` (on the Linux dev machine)
Expected: builds cleanly, `src-tauri` compiles against `meeting_notes_audio::RecordingHandle` with zero changes required.

- [ ] **Step 3: Manual smoke test through the actual app**

Run: `bun run tauri dev`, complete a full start/stop recording cycle as done in plans 04–05's manual verification.
Expected: identical behavior to before the refactor — this confirms the facade change is invisible above the crate boundary.

- [ ] **Step 4: Commit (only if any adjustment was needed in Step 1)**

```bash
git add src-tauri/src/commands/recording_commands.rs
git commit -m "chore: confirm recording commands unaffected by audio facade refactor"
```

---

### Task 3: Add platform-selection scaffolding for the upcoming macOS module

**Files:**
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Modify: `crates/meeting-notes-audio/Cargo.toml`

- [ ] **Step 1: Add the cfg-gated macOS module declaration (empty stub, filled in by Plan 15)**

```rust
// crates/meeting-notes-audio/src/lib.rs (additions)
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::RecordingHandle;
```

Create an empty placeholder so the crate still compiles on Linux (where this module is cfg'd out entirely) — no file is needed yet on the Linux dev machine since `mod macos` only activates under `target_os = "macos"`.

- [ ] **Step 2: Add a compile-time guard for unsupported platforms**

```rust
// crates/meeting-notes-audio/src/lib.rs (additions)
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("meeting-notes-audio currently supports Linux and macOS only");
```

- [ ] **Step 3: Verify the crate still builds on Linux with the macOS branch cfg'd out**

Run: `cargo build -p meeting-notes-audio` (on the Linux dev machine)
Expected: builds cleanly — the `#[cfg(target_os = "macos")]` module and its `pub use` are simply not compiled on Linux, and the `compile_error!` guard doesn't fire since Linux matches the `any(...)` clause.

- [ ] **Step 4: Commit**

```bash
git add crates/meeting-notes-audio/src/lib.rs crates/meeting-notes-audio/Cargo.toml
git commit -m "feat: add platform-selection scaffolding for macOS audio backend"
```
