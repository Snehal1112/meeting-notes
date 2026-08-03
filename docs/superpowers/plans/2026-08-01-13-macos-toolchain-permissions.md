# macOS Toolchain & Permissions Verification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan MUST run before Plan 14 (audio facade refactor) and Plan 15 (macOS audio capture).** Like Plan 00, every step here is a standalone verification with no app code — the goal is to prove ScreenCaptureKit and mic capture work on this exact Mac before any Rust code depends on them.

**Goal:** Verify the macOS build toolchain, confirm the OS version supports ScreenCaptureKit audio capture, and walk through the permission prompts (Screen Recording, Microphone) standalone so the app's first real launch doesn't hit an unexpected permission wall.

**Architecture:** No app code. Verification only — confirms Xcode Command Line Tools, Rust/Node/bun, macOS version ≥ 13, and exercises a minimal standalone Swift capture script to trigger and confirm the Screen Recording permission grant before any Rust/ScreenCaptureKit bindings are involved.

**Tech Stack:** Bash, Swift (`swift` CLI, for the standalone permission/capture check only — not part of the shipped app), Xcode Command Line Tools

**Why this plan exists:** ScreenCaptureKit audio capture requires the user to grant Screen Recording permission via a system prompt the first time it's used — and that prompt is notoriously easy to miss or dismiss, after which the app silently gets empty audio with no obvious error. Triggering and confirming that grant with a minimal standalone script here means Plan 15's Rust code is never the first thing exercising that permission flow.

---

### Task 1: Verify macOS build prerequisites

**Files:**
- Modify: `docs/superpowers/specs/environment.md`

- [ ] **Step 1: Confirm macOS version supports ScreenCaptureKit audio capture**

```bash
sw_vers -productVersion
```

Expected: `13.0` or higher (ScreenCaptureKit's audio-capture APIs, as opposed to video-only, were introduced in macOS 13 Ventura). If below 13, the macOS system-audio path in Plan 15 is not available on this machine — record that in `environment.md` now and treat mic-only as the confirmed baseline for this Mac.

- [ ] **Step 2: Confirm Xcode Command Line Tools are installed**

```bash
xcode-select -p
swift --version
```

Expected: a valid path (e.g. `/Library/Developer/CommandLineTools`) and a Swift version. If missing: `xcode-select --install`.

- [ ] **Step 3: Confirm Rust, Node, and bun versions**

```bash
rustc --version
cargo --version
node --version
bun --version
```

Expected: same minimums as Plan 00 (Rust 1.75+, Node 18+, bun 1.1+). Install any missing via `rustup`, `nvm`, or `curl -fsSL https://bun.sh/install | bash`.

- [ ] **Step 4: Record findings**

Append to `docs/superpowers/specs/environment.md`: macOS version, Xcode CLT status, Rust/Node/bun versions.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/environment.md
git commit -m "chore: record verified macOS build prerequisites"
```

---

### Task 2: Trigger and confirm Screen Recording permission via a standalone Swift script

**Files:**
- Create: `test-fixtures/macos/sck-audio-check.swift` (throwaway verification script, not part of the shipped app)
- Modify: `docs/superpowers/specs/environment.md`

- [ ] **Step 1: Write a minimal standalone ScreenCaptureKit audio capture script**

```swift
// test-fixtures/macos/sck-audio-check.swift
import ScreenCaptureKit
import AVFoundation

@available(macOS 13.0, *)
func checkAudioCapture() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            print("NO_DISPLAY_FOUND")
            return
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = false

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        print("PERMISSION_GRANTED_STREAM_CREATED")
    } catch {
        print("PERMISSION_DENIED_OR_ERROR: \(error)")
    }
}

if #available(macOS 13.0, *) {
    Task {
        await checkAudioCapture()
        exit(0)
    }
    RunLoop.main.run()
} else {
    print("MACOS_VERSION_TOO_OLD")
}
```

- [ ] **Step 2: Run it and grant permission when prompted**

```bash
swift test-fixtures/macos/sck-audio-check.swift
```

Expected: macOS shows a system dialog "wants to record this computer's screen and audio" — click **Open System Settings** and enable it for your terminal app (Terminal.app, iTerm2, etc.) under **Privacy & Security → Screen Recording**, then re-run the script.

- [ ] **Step 3: Re-run after granting permission**

```bash
swift test-fixtures/macos/sck-audio-check.swift
```

Expected output: `PERMISSION_GRANTED_STREAM_CREATED`. If you still see `PERMISSION_DENIED_OR_ERROR`, quit and reopen your terminal app completely (macOS caches the permission state per-process-launch) and try again.

- [ ] **Step 4: Record findings**

Append to `docs/superpowers/specs/environment.md`: confirmation that Screen Recording permission was granted successfully, which terminal/app needed the grant (this matters — once bundled, the Tauri app itself will need this same grant under its own name, not the terminal's), and any error text seen along the way.

- [ ] **Step 5: Commit**

```bash
git add test-fixtures/macos/sck-audio-check.swift docs/superpowers/specs/environment.md
git commit -m "chore: verify ScreenCaptureKit audio permission flow standalone"
```

---

### Task 3: Verify microphone capture and permission standalone

**Files:**
- Modify: `docs/superpowers/specs/environment.md`

- [ ] **Step 1: Record 5 seconds of mic audio via ffmpeg or sox (standalone, not the final cpal-based approach) to confirm mic hardware + OS permission work at all**

```bash
which ffmpeg || brew install ffmpeg
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -A5 "AVFoundation audio"
```

Expected: your Mac's microphone appears in the device list (e.g. `[0] MacBook Pro Microphone`).

- [ ] **Step 2: Record and play back**

```bash
ffmpeg -f avfoundation -i ":0" -t 5 /tmp/mic-test.wav
afplay /tmp/mic-test.wav
```

(Adjust `:0` to match the audio device index found in Step 1.) Expected: macOS prompts for Microphone permission on first run — grant it, then confirm you hear your own voice in playback. This confirms the hardware and OS-level permission both work before Plan 15's `cpal`-based Rust implementation depends on them.

- [ ] **Step 3: Record findings**

Append to `docs/superpowers/specs/environment.md`: confirmed working audio device index/name, confirmation microphone permission was granted, any issues encountered.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/environment.md
git commit -m "chore: verify standalone microphone capture and permission on macOS"
```
