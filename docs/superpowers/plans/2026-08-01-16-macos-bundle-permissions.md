# macOS Tauri Bundle & Permissions Configuration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Run after Plan 15 (macOS audio capture implemented) and before distributing a macOS build to anyone else.

**Goal:** Configure the Tauri bundle so the packaged macOS app (not just a raw `cargo run` binary) correctly triggers and labels the Microphone and Screen Recording permission prompts, and document what's needed for others to run a built `.app`/`.dmg` beyond your own dev machine.

**Architecture:** Tauri's `tauri.conf.json` `bundle.macOS` section controls `Info.plist` entries. `NSMicrophoneUsageDescription` and a screen-recording-related usage string are required — without them, macOS either denies the permission silently or shows a prompt with no explanation of why the app wants access, which reads as suspicious and increases the chance a user just denies it.

**Tech Stack:** Tauri config (`tauri.conf.json`), macOS `Info.plist` entries, `codesign` (mentioned for context, not implemented in this MVP)

---

### Task 1: Add required Info.plist usage description strings

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add macOS bundle permission strings**

```json
{
  "bundle": {
    "macOS": {
      "entitlements": null,
      "minimumSystemVersion": "13.0",
      "exceptionDomain": "",
      "signingIdentity": null,
      "providerShortName": null,
      "frameworks": [],
      "files": {},
      "infoPlist": {
        "NSMicrophoneUsageDescription": "Meeting Notes needs microphone access to record your voice during meetings.",
        "NSScreenCaptureDescription": "Meeting Notes needs screen recording access to capture system audio (other participants' voices) during meetings. No video or screen content is recorded or stored."
      }
    }
  }
}
```

Note: `minimumSystemVersion: "13.0"` matches the ScreenCaptureKit audio-capture requirement from the design doc — this makes Tauri's own bundler reject building for pre-13 targets rather than shipping a build that silently can't capture system audio.

- [ ] **Step 2: Rebuild the macOS bundle and inspect the generated Info.plist**

```bash
bun run tauri build
plutil -p "src-tauri/target/release/bundle/macos/Meeting Notes.app/Contents/Info.plist" | grep -A1 "NSMicrophone\|NSScreenCapture"
```

Expected: both usage description strings appear in the generated `Info.plist`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat: add macOS Info.plist permission usage descriptions"
```

---

### Task 2: Verify permission prompts show correct app identity and text

**Files:**
- None (verification only)

- [ ] **Step 1: Run the actual built .app bundle (not `tauri dev`) and trigger both permissions fresh**

First reset any permission grants from earlier testing so the prompts fire again as a new user would see them:

```bash
tccutil reset Microphone com.meeting-notes.app
tccutil reset ScreenCapture com.meeting-notes.app
```

(Adjust the bundle identifier to match whatever is set in `tauri.conf.json`'s `identifier` field.)

- [ ] **Step 2: Launch the built app and start a recording**

```bash
open "src-tauri/target/release/bundle/macos/Meeting Notes.app"
```

Start a recording from the widget. Expected: the Microphone permission dialog shows "Meeting Notes" as the requesting app (not "Terminal" or a generic name) with the usage description text from Task 1. The Screen Recording dialog should appear similarly on first system-audio capture attempt.

- [ ] **Step 3: Grant both and confirm a full recording cycle works from the bundled app**

Expected: recording, transcription, and summary all work identically to the `tauri dev` testing done in plans 04–15 — this confirms the permission configuration is correct for distribution, not just for your already-permitted dev environment.

- [ ] **Step 4: Document distribution caveats**

Note in `docs/superpowers/specs/environment.md`: this MVP build is unsigned/unnotarized, so anyone else running the `.app` will see Gatekeeper's "unidentified developer" warning and need to right-click → Open the first time (or `xattr -d com.apple.quarantine` the app). Proper code signing and notarization (an Apple Developer account + `codesign`/`notarytool`) is a distribution concern out of scope for this MVP but worth flagging now rather than discovering it when sharing the build with someone else.

---

**No Task 3 for this plan** — two tasks fully cover the bundle configuration and its verification; a third would only be padding.
