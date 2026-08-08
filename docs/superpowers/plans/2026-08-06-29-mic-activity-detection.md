# Surface Widget on External Mic Activity (Linux) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plans 04/05 (mic capture via `pw-record`, whose process name this plan filters against) being complete.

**Goal:** Detect when *another* application (Zoom, a browser meeting tab, etc.) starts using the system microphone, and bring the widget to the front with a dismissible prompt — **not** auto-start recording. The user still has to click Start Recording; this only solves "I forgot the widget existed until I was already five minutes into the call."

**Scope:** Linux only, matching how audio capture itself was built Linux-first before macOS. Uses `pactl subscribe` (works against PipeWire via its PulseAudio compatibility layer) rather than the `pipewire-rs` crate — consistent with this project's established pattern of shelling out to system binaries (`pw-record`, `pactl`) instead of deep PipeWire API integration.

**Architecture:** A background task, spawned once at app startup, runs `pactl subscribe` and reads its continuous event stream line-by-line. On each `source-output` "new" event, it looks up that stream's owning process via `pactl list source-outputs` and checks two things: (1) is this actually a mic-capture stream, not e.g. a monitor-source tap, and (2) is the owning process something other than this app's own `pw-record` — otherwise every recording this app makes would immediately re-trigger its own "mic is active" prompt. When both checks pass, it emits a `external-mic-activity` Tauri event, debounced so an already-detected ongoing external session doesn't keep re-firing. The frontend brings the window to front and shows a dismissible inline banner on Idle — reusing the same banner pattern already established for the orphaned-recording resume prompt, not a new modal.

> **Pre-flight review (2026-08-08):** this plan was written against an earlier/aspirational snapshot of the codebase. Verified corrections below, each also inlined as a `> **Deviation:**` note at its exact step:
> 1. **`pactl` is not installed in this dev/target environment** (only `pw-record`, `wpctl`, `pw-cli`, `pw-mon`, `pw-dump` are — `linux.rs`'s own comments already flag that `pactl` may be absent). Decision (confirmed with the project owner): keep this plan's `pactl`-based mechanism as written, and add `pulseaudio-utils` as a **required** (not "ideally") prerequisite in `README.md` — folded into Task 3 below as a new step, since `README.md`'s Prerequisites section already lists `pulseaudio-utils` as optional/"ideally" and needs updating to say this feature requires it.
> 2. **The `.setup(|app| {...})` closure lives in `src-tauri/src/lib.rs`'s `pub fn run()` (lines 44-120, closure body 51-92)** — `src-tauri/src/main.rs` is a 12-line stub (just sets `GDK_BACKEND=x11` and calls `meeting_notes_lib::run()`) with no `.setup()` at all. Every "modify main.rs's setup closure" instruction below means `lib.rs`.
> 3. **"Plan 21" and its global-shortcut registration do not exist anywhere in this repo** (`docs/superpowers/plans/` has no file numbered 21-23; grepping `src-tauri` for `global_shortcut`/`GlobalShortcut` returns nothing). Ignore that anchor — `start_mic_watcher` is added directly into the existing `setup` closure in `lib.rs`, after the existing `on_window_event` block, before its closing `Ok(())`.
> 4. **`commands/mic_watcher_commands.rs` holding a plain (non-`#[tauri::command]`) `start_mic_watcher(&AppHandle)` function is consistent with this codebase's real convention** — `commands/window_commands.rs` already does exactly this (`pub fn apply_click_through(window: &WebviewWindow, active: bool)`, called directly from `lib.rs`'s setup closure, not through `invoke_handler`). No change needed here, just confirming the plan is right.
> 5. **`app.emit(...)` (the `Emitter` trait) and frontend `listen()` are both already-established patterns** (`summary_commands.rs`, `transcription_commands.rs` emit `summary-complete`/`transcription-complete`; `src/lib/transcription.ts` + `RecorderWidget.tsx` already listen for one). No new Tauri capability is needed for `listen()` itself — `core:default` already covers it (confirmed: the two existing events work with no per-event permission entry in `capabilities/default.json`).
> 6. **`getCurrentWindow().setFocus()` is genuinely new API surface and WILL be denied at runtime without a capability change.** `core:window:default` (pulled in transitively by `core:default`) is read/query-only; `core:window:allow-set-focus` is a separate permission not present in `src-tauri/capabilities/default.json` today. Folded into Task 3 below as a new step.
> 7. **The frontend `listen()` sample in Task 3 Step 3 omits the `cancelled`-guard this codebase's only other `listen()` consumer uses** (`RecorderWidget.tsx`'s `onTranscriptionComplete` effect awaits the `listen()` promise behind a `cancelled` flag to survive React StrictMode's double-invoke). Corrected sample given at that step.
> 8. **The banner's actual JSX render guard must mirror `ResumePrompt`'s real condition**, `!isPill && !showConfigDialog && !showHistory` (`App.tsx:235`) — not `widgetState === "idle"` alone, which would let the banner render over the ConfigDialog/History screens (neither of those resets `widgetState`). Corrected placement given at that step.
> 9. No precedent exists in this codebase for a long-running/looping background thread (only two short one-shot delayed threads exist today) — not a blocker, but the task reviewer should give `watch_mic_activity`'s loop and its `Mutex::lock().unwrap()` extra scrutiny since nothing else in this codebase holds a thread open for the app's full lifetime.

---

### Task 1: Background pactl subscribe watcher with self-filtering

**Files:**
- Create: `crates/meeting-notes-audio/src/mic_watcher.rs`
- Modify: `crates/meeting-notes-audio/src/lib.rs`
- Create: `crates/meeting-notes-audio/src/mic_watcher_tests.rs`

- [ ] **Step 1: Write failing test for parsing pactl's source-output event lines**

```rust
// crates/meeting-notes-audio/src/mic_watcher_tests.rs
use super::mic_watcher::*;

#[test]
fn parses_new_source_output_event() {
    let line = "Event 'new' on source-output #42";
    assert_eq!(parse_subscribe_line(line), Some(SourceOutputEvent { id: 42 }));
}

#[test]
fn ignores_unrelated_event_lines() {
    let line = "Event 'change' on sink #3";
    assert_eq!(parse_subscribe_line(line), None);
}

#[test]
fn ignores_source_output_remove_events() {
    // Only "new" matters here — a stream ending isn't "mic activity starting."
    let line = "Event 'remove' on source-output #42";
    assert_eq!(parse_subscribe_line(line), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio mic_watcher -- --nocapture`
Expected: FAIL — `mic_watcher` module doesn't exist.

- [ ] **Step 3: Implement event line parsing**

```rust
// crates/meeting-notes-audio/src/mic_watcher.rs
#[derive(Debug, PartialEq, Eq)]
pub struct SourceOutputEvent {
    pub id: u32,
}

/// Parses one line of `pactl subscribe` output. Only "new source-output"
/// events matter here — that's what fires the instant an application opens
/// a capture stream from any source (including the mic).
pub fn parse_subscribe_line(line: &str) -> Option<SourceOutputEvent> {
    if !line.contains("'new'") || !line.contains("source-output") {
        return None;
    }
    let id_str = line.rsplit('#').next()?;
    let id = id_str.trim().parse().ok()?;
    Some(SourceOutputEvent { id })
}

#[cfg(test)]
mod mic_watcher_tests;
```

Register `pub mod mic_watcher;` in `crates/meeting-notes-audio/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio mic_watcher -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src
git commit -m "feat: parse pactl subscribe source-output events"
```

---

### Task 2: Filter out this app's own recording, resolve stream details

**Files:**
- Modify: `crates/meeting-notes-audio/src/mic_watcher.rs`
- Modify: `crates/meeting-notes-audio/src/mic_watcher_tests.rs`

- [ ] **Step 1: Write failing test for self-filtering**

```rust
// crates/meeting-notes-audio/src/mic_watcher_tests.rs (additions)
#[test]
fn is_own_recording_detects_pw_record_process_name() {
    let details = "application.process.binary = \"pw-record\"\napplication.name = \"pw-record\"";
    assert!(is_own_recording(details));
}

#[test]
fn is_own_recording_false_for_other_processes() {
    let details = "application.process.binary = \"zoom\"\napplication.name = \"Zoom Meeting\"";
    assert!(!is_own_recording(details));
}

#[test]
fn is_mic_capture_true_for_real_input_source() {
    let details = "source: alsa_input.pci-0000_00_1f.3.analog-stereo\nmedia.class = \"Stream/Input/Audio\"";
    assert!(is_mic_capture(details));
}

#[test]
fn is_mic_capture_false_for_monitor_source_tap() {
    // System-audio monitoring (e.g. this app's own system-audio capture, or
    // an audio visualizer) taps a `.monitor` source, not the mic itself —
    // shouldn't count as "someone is using the mic."
    let details = "source: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor\nmedia.class = \"Stream/Input/Audio\"";
    assert!(!is_mic_capture(details));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-audio mic_watcher -- --nocapture`
Expected: FAIL — `is_own_recording`/`is_mic_capture` not defined.

- [ ] **Step 3: Implement the filters and the lookup that fetches stream details**

```rust
// crates/meeting-notes-audio/src/mic_watcher.rs (additions)
use std::process::Command;

pub fn is_own_recording(details: &str) -> bool {
    details.contains("pw-record")
}

pub fn is_mic_capture(details: &str) -> bool {
    details.contains("source:") && !details.contains(".monitor")
}

/// Fetches `pactl list source-outputs` and returns the block of text for
/// the given stream id, if it still exists (streams can end between the
/// "new" event firing and this lookup running — treat that as "nothing to
/// report" rather than an error).
pub fn fetch_source_output_details(id: u32) -> Option<String> {
    let output = Command::new("pactl")
        .args(["list", "source-outputs"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let marker = format!("Source Output #{id}");
    let block_start = text.find(&marker)?;
    let rest = &text[block_start..];
    let block_end = rest[1..].find("Source Output #").map(|i| i + 1).unwrap_or(rest.len());
    Some(rest[..block_end].to_string())
}

/// The combined check this task exists for: is this event genuinely
/// "someone else started using the mic," as opposed to this app's own
/// recording or an unrelated monitor-source tap.
pub fn is_external_mic_activity(id: u32) -> bool {
    match fetch_source_output_details(id) {
        Some(details) => is_mic_capture(&details) && !is_own_recording(&details),
        None => false,
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-audio mic_watcher -- --nocapture`
Expected: PASS. Note `is_external_mic_activity` itself isn't unit tested here since it shells out — covered by Task 3's manual verification instead.

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src
git commit -m "feat: filter external mic-capture streams from this app's own recording"
```

---

### Task 3: Background watcher task, debouncing, Tauri event, frontend banner

**Files:**
- Modify: `crates/meeting-notes-audio/src/mic_watcher.rs`
- Create: `src-tauri/src/commands/mic_watcher_commands.rs`
- Modify: `src-tauri/src/lib.rs` (**Deviation:** not `main.rs` — see pre-flight note above; `pub mod commands;` is already declared there, `mic_watcher_commands` just needs adding to that module tree via `src-tauri/src/commands/mod.rs`)
- Modify: `src-tauri/src/commands/mod.rs` (**Deviation, new file not in original list:** add `pub mod mic_watcher_commands;` alongside the other `pub mod X;` re-exports)
- Modify: `src-tauri/capabilities/default.json` (**Deviation, new file not in original list:** add `"core:window:allow-set-focus"` — see pre-flight note #6)
- Modify: `README.md` (**Deviation, new file not in original list:** Prerequisites item 5 — see pre-flight note #1)
- Modify: `src/App.tsx`
- Create: `src/components/MicActivityBanner.tsx`

- [ ] **Step 1: Spawn the background watcher, debounced per stream id**

```rust
// crates/meeting-notes-audio/src/mic_watcher.rs (additions)
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

/// Runs `pactl subscribe` indefinitely, calling `on_external_mic_activity`
/// once per genuinely-new external mic-capture stream. `seen_ids` prevents
/// re-firing for state-change events on a stream we've already reported —
/// an ongoing Zoom call shouldn't spam the prompt repeatedly.
pub fn watch_mic_activity(on_external_mic_activity: impl Fn() + Send + 'static) -> std::io::Result<()> {
    let mut child = Command::new("pactl")
        .arg("subscribe")
        .stdout(Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "failed to capture pactl subscribe stdout")
    })?;

    let seen_ids: Arc<Mutex<HashSet<u32>>> = Arc::new(Mutex::new(HashSet::new()));

    for line in BufReader::new(stdout).lines().filter_map(|l| l.ok()) {
        let Some(event) = parse_subscribe_line(&line) else { continue };

        let mut seen = seen_ids.lock().unwrap();
        if seen.contains(&event.id) {
            continue;
        }

        if is_external_mic_activity(event.id) {
            seen.insert(event.id);
            drop(seen);
            on_external_mic_activity();
        }
    }

    Ok(())
}
```

Note: `seen_ids` grows unboundedly over a long-running session (never removes entries when streams end, since `pactl subscribe`'s `remove` events are intentionally ignored per Task 1). For a background watcher meant to run for the app's entire lifetime, this is a slow, harmless memory growth (a few bytes per detected stream) rather than a real leak — not worth the complexity of tracking removal events just to prune it, but worth knowing this tradeoff exists rather than treating the set as bounded.

- [ ] **Step 2: Spawn the watcher at app startup, wire the Tauri event**

```rust
// src-tauri/src/commands/mic_watcher_commands.rs
use meeting_notes_audio::mic_watcher::watch_mic_activity;
use tauri::{AppHandle, Emitter, Manager};

pub fn start_mic_watcher(app: &AppHandle) {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let _ = watch_mic_activity(move || {
            let _ = app_handle.emit("external-mic-activity", ());
        });
        // If watch_mic_activity ever returns (pactl not installed, process
        // died, etc.), this silently stops watching for the rest of the
        // session rather than crashing the app — acceptable degradation
        // for a convenience feature, but worth a log line here in practice
        // so it's not a silent, undiagnosable feature loss.
    });
}
```

> **Deviation:** register the module first — add `pub mod mic_watcher_commands;` to `src-tauri/src/commands/mod.rs` (alongside its existing `pub mod config_commands;` etc. re-exports).
>
> Then call `start_mic_watcher(&app.handle())` inside `src-tauri/src/lib.rs`'s **existing** `setup` closure (`pub fn run()`, the closure spanning lines 51-92) — **not** `main.rs` (a 12-line stub with no `.setup()`), and **not** "alongside a global-shortcut registration from plan 21" (no such plan or registration exists in this repo). Add it as a new statement right after the existing `if let Some(window) = app.get_webview_window("main") { ... }` / `on_window_event` block, before the closure's trailing `Ok(())`:
> ```rust
> // src-tauri/src/lib.rs, inside the existing .setup(|app| { ... }) closure,
> // after the on_window_event block and before `Ok(())`:
> commands::mic_watcher_commands::start_mic_watcher(app.handle());
> ```

- [ ] **Step 3: Frontend — bring window to front, show dismissible banner**

```tsx
// src/components/MicActivityBanner.tsx
import { Button } from "@/components/ui/button";
import { Mic } from "lucide-react";

interface MicActivityBannerProps {
  onDismiss: () => void;
}

export function MicActivityBanner({ onDismiss }: MicActivityBannerProps) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs bg-muted/60 border rounded-md px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Mic className="h-3 w-3 text-primary" />
        <span>Mic is active — start recording?</span>
      </div>
      <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
```

> **Deviation:** the sample below replaces the plan's original — corrected against `App.tsx`'s real structure (confirmed lines 1-262 as of this pre-flight review) and `RecorderWidget.tsx`'s real `listen()` precedent, which guards against React StrictMode's double-invoke with a `cancelled` flag (the plan's original `unlistenPromise.then(...)` cleanup omits this). `ResumePrompt`'s real render guard is `!isPill && !showConfigDialog && !showHistory` (`App.tsx:235`), a sibling conditional block — not `widgetState === "idle"` alone — so the banner must use the same guard or it will incorrectly render over the ConfigDialog/History screens (neither resets `widgetState`).

```tsx
// src/components/MicActivityBanner.tsx
import { Button } from "@/components/ui/button";
import { Mic } from "lucide-react";

interface MicActivityBannerProps {
  onDismiss: () => void;
}

export function MicActivityBanner({ onDismiss }: MicActivityBannerProps) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs bg-muted/60 border rounded-md px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Mic className="h-3 w-3 text-primary" />
        <span>Mic is active — start recording?</span>
      </div>
      <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
```

```tsx
// src/App.tsx additions:
// 1. New imports alongside the existing ones at the top of the file:
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MicActivityBanner } from "@/components/MicActivityBanner";

// 2. New state, alongside the other useState calls (e.g. after `resumeMeeting`):
const [showMicBanner, setShowMicBanner] = useState(false);

// 3. New effect, alongside the other useEffect calls — mirrors the
// cancelled-guard pattern RecorderWidget.tsx's onTranscriptionComplete
// effect already uses for the same StrictMode double-invoke hazard:
useEffect(() => {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  (async () => {
    const stopListening = await listen("external-mic-activity", () => {
      if (cancelled) return;
      if (widgetState === "idle") {
        getCurrentWindow().setFocus().catch((err) =>
          console.error("Could not focus window for mic activity:", err)
        );
        setShowMicBanner(true);
      }
      // Deliberately no-op if already recording/processing — the user is
      // already doing the thing this banner would have suggested.
    });
    if (cancelled) {
      stopListening();
      return;
    }
    unlisten = stopListening;
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}, [widgetState]);

// 4. Render: as its own sibling conditional block immediately after the
// existing ResumePrompt block (App.tsx:235-241), reusing that exact same
// guard so the banner never appears over ConfigDialog/History:
{!isPill && !showConfigDialog && !showHistory && showMicBanner && (
  <MicActivityBanner onDismiss={() => setShowMicBanner(false)} />
)}
```

> **Deviation, new step — Tauri capability for `setFocus()`:** add `"core:window:allow-set-focus"` to the `permissions` array in `src-tauri/capabilities/default.json` (which currently grants `core:default`, `opener:default`, `core:window:allow-start-dragging`, `core:window:allow-set-size`, `core:window:allow-current-monitor`, `core:window:allow-close`, `dialog:allow-open` — none of which cover window focus). Without this, `getCurrentWindow().setFocus()` is denied at runtime. `listen()` itself needs no capability change (already covered by `core:default`, confirmed against the two existing `transcription-complete`/`summary-complete` events working today with no per-event permission entries).

> **Deviation, new step — document the `pactl` dependency:** update `README.md`'s Prerequisites item 5 (currently: *"PipeWire audio tooling — `pw-record` ... and, ideally, `pactl` from `pulseaudio-utils`"*, with a fallback note that `wpctl`/`pw-cli` work as a substitute if `pactl` is unavailable) to say the mic-activity-detection feature specifically **requires** `pactl` (`pulseaudio-utils`) — it is not optional for that feature, even though it remains optional for basic recording. Keep the existing `sudo apt install -y pipewire-utils pulseaudio-utils` line (it already includes `pulseaudio-utils`); just correct the surrounding prose so a reader doesn't skip installing it and then find mic-activity detection silently doing nothing.

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`. With the widget in Idle state, start a call in a separate application that uses the mic (a browser Meet/Zoom tab, or just `pactl` — e.g. `parec > /dev/null &` as a synthetic mic-capture stream for testing). Confirm the widget window comes to front and the banner appears within a second or two. Dismiss it and confirm it doesn't reappear for the same ongoing external session. Separately, start a recording *from this app itself* and confirm the banner does **not** appear for its own `pw-record` stream. Also confirm nothing happens if mic activity starts while already Recording/Processing.

- [ ] **Step 5: Commit**

```bash
git add crates/meeting-notes-audio/src src-tauri/src/commands/mic_watcher_commands.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json README.md src/App.tsx src/components/MicActivityBanner.tsx
git commit -m "feat: surface widget with dismissible banner on external mic activity (Linux)"
```
