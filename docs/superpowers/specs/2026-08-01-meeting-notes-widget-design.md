# Meeting Notes Widget — Design Spec

**Date:** 2026-08-01
**Status:** Approved
**Author:** Snehal Dangroshiya

## 1. Overview & Goals

A small, always-on-top floating desktop widget (Tauri + Rust + React/TypeScript +
shadcn/ui) that records a live meeting's audio (mic + system audio) on **Linux
(Ubuntu, PipeWire) and macOS (ScreenCaptureKit)**, transcribes it locally with
whisper.cpp, and generates a summary + flat action-item list via a pluggable LLM
provider (Claude API or local Ollama).

**Positioning:** standalone product/self-hostable tool, portfolio project, and MVP
to validate the concept — not tied to NumericLabs/NHe4a.

**Explicitly out of scope for this MVP:**
- Speaker diarization / identification (audio-based who-said-what; text-based
  attendee inference from transcript content is now in scope — see Section 6)
- Due dates on action items (assignee is now in scope; due date remains
  deferred)
- Meeting list / history browser UI
- Settings screen (replaced by first-launch config dialog + config file/env vars)
- Windows support
- Meeting-platform bot integration (Zoom/Meet API) — noted as a future direction,
  not part of this build

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│              Tauri Desktop App                 │
│  ┌───────────────┐      ┌──────────────────┐  │
│  │ React + shadcn  │◄────►│   Rust Backend    │  │
│  │  (Frontend)     │      │  (Tauri Commands) │  │
│  └───────────────┘      └──────────────────┘  │
└──────────────────────────┬─────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌─────────────────┐  ┌───────────────┐
│ Audio Capture   │  │  whisper.cpp     │  │  LLM Provider   │
│ (PipeWire,      │  │  (local          │  │  (Claude API    │
│  mic + monitor) │  │   transcription) │  │   or Ollama)    │
└───────────────┘  └─────────────────┘  └───────────────┘
        │                   │                   │
        ▼                   ▼                   ▼
┌─────────────────────────────────────────────────┐
│   Local filesystem: audio/, transcripts/, index   │
└─────────────────────────────────────────────────┘
```

**Core flow:**
1. User clicks "Start Recording" in the floating widget → Rust backend captures
   mic + system audio (mixed) via PipeWire.
2. User clicks "Stop" → audio saved to disk as `audio.wav`.
3. Backend runs whisper.cpp on the audio file → transcript with timestamps.
4. Transcript sent to configured LLM provider (Claude API or Ollama) → summary +
   flat action-item list returned as JSON.
5. Widget displays summary + action items inline; everything persisted to local
   files.

## 3. Data & File Storage

```
~/.local/share/meeting-notes/
├── index.json                          # lightweight index of all meetings
└── meetings/
    └── 2026-08-01_143000_team-sync/
        ├── audio.wav                   # raw recording (mic + system, mixed)
        ├── transcript.json             # segments with timestamps
        ├── transcript.txt              # plain text (LLM input)
        ├── summary.md                  # generated summary
        └── action_items.json           # flat list of extracted todos
```

- `index.json`: array of meeting metadata (title, **meeting type**, date, duration,
  status) — even though there's no list UI in this MVP, this keeps a record on
  disk and makes a future list view a pure UI addition, not a data-model change.
- `transcript.json`: array of `{ start_time, end_time, text }` segments — kept
  even without diarization so a future speaker field can be added without a
  format change.
- `action_items.json`: array of `{ id, text, assignee: Option<String>, completed }`
  — `assignee` is populated when the LLM confidently attributes an action item to
  a named participant identified from the transcript text (see Section 6), and
  left `null` otherwise rather than guessing.

## 4. Audio Capture (Rust backend, cross-platform)

`meeting-notes-audio` exposes one public API — `RecordingHandle::start(path) ->
(Self, used_system_audio: bool)`, `.stop()`, `.output_path()` — used identically
by every other crate and by `src-tauri`. Internally it dispatches to a
platform-specific backend via `#[cfg(target_os = "...")]`, so nothing above this
crate needs to know which OS it's running on.

**Linux (Ubuntu 22.04+, PipeWire):**
- Capture **mic input** and **system audio (monitor source)** simultaneously via
  `pw-record` shell-outs, mixed into a single `audio.wav`.
- Mixing done via basic sample summing; written out via the `hound` crate.

**macOS (13+, ScreenCaptureKit):**
- Capture **mic input** via the `cpal` crate (cross-platform Rust audio I/O,
  backed by CoreAudio on macOS).
- Capture **system audio** via ScreenCaptureKit's audio-capture APIs (macOS
  13+), using an `SCStream` configured with `capturesAudio = true` and no video
  output — no virtual audio driver (e.g. BlackHole) required.
- Both streams mixed into `audio.wav` via the same `hound`-based mixing logic
  used on Linux (platform-agnostic — it operates on WAV files, not on capture
  internals).
- Requires the user to grant Screen Recording permission (macOS prompts for this
  automatically on first capture attempt) and Microphone permission.

**Common to both platforms:**
- Dual-track (separate mic/system files) deferred — noted as the natural
  foundation for future speaker diarization.

**Failure handling:**
- No monitor source (Linux) / no Screen Recording permission (macOS) → fall back
  to mic-only silently; tracked via `used_system_audio` on `MeetingMeta` rather
  than shown as a warning during recording (the compact pill has no room for one
  — see Section 8).
- Recording interrupted (crash/sleep) → partial audio file preserved; on next
  launch, detect orphaned recordings and offer to resume transcription on them.

## 5. Transcription (whisper.cpp)

- Shell out to a bundled `whisper.cpp` binary (or `whisper-rs` bindings) — no
  reimplementation.
- Default model: `base.en` or `small.en` (speed/accuracy tradeoff on typical
  laptop hardware); model choice configurable via config file/env var/first-launch
  dialog.
- Runs as an async Tauri background task so the UI stays responsive; widget shows
  a "Transcribing…" state.
- Output parsed into `transcript.json` + `transcript.txt`.
- Expectation: a 30–60 min meeting may take several minutes to transcribe on CPU
  — UI must reflect real progress, not a fake instant result.

## 6. Summary & Action Item Generation (LLM layer)

- Rust trait `SummaryProvider` with two implementations:
  - **Claude API** — sends `transcript.txt` with a structured prompt, requests
    JSON back.
  - **Ollama (local)** — same prompt/contract over local HTTP.
- **Provider selection is no longer purely a background config default.** The
  widget shows a picker (defaulting to whichever provider `resolve_config()`
  would auto-select) before summarization starts, and the Done state offers
  "Regenerate with [other provider]" so the user can compare Claude vs. Ollama
  output on the same transcript without re-recording.
- **Attendee identification is text-based, not audio-based.** Speaker
  diarization (who-said-what by voice) remains explicitly out of scope — instead,
  the LLM is prompted to infer participant names from what's actually said in the
  transcript (self-introductions, being addressed by name, etc.) and return an
  `attendees` list. This is inherently best-effort: if no names are confidently
  identifiable from the conversation content, the list is empty rather than
  guessing, and the UI reflects that plainly rather than implying certainty.
- **Meeting types** drive which summary structure is used. Supported types:
  Standup, Retrospective, Feature Request, Incident, and a generic/Auto-detect
  fallback. Per current scope: **Standup, Incident, and Feature Request meetings
  use the Notion-style generic format**; **Retrospective (and Auto-detect, when
  the LLM can't confidently match a specific type) uses a type-specific
  structure**. The user can pick a type explicitly at recording start, or leave
  it on "Auto-detect" and let the LLM classify it from the transcript.

**Notion-style format** (Standup, Incident, Feature Request, and the default
for Auto-detect when no more specific structure applies):
```json
{
  "meeting_type": "incident",
  "attendees": ["..."],
  "discussion_notes": "...",
  "decisions": ["..."],
  "action_items": [{ "text": "...", "assignee": "..." }]
}
```
Rendered to `summary.md` as Notion's canonical structure: **Attendees**,
**Discussion Notes**, **Decisions**, **Action Items** (checklist, each with an
assignee where identified).

**Type-specific format** (Retrospective, and any other custom type not mapped to
the Notion-style default):
```json
{
  "meeting_type": "retrospective",
  "attendees": ["..."],
  "what_went_well": ["..."],
  "what_didnt_go_well": ["..."],
  "action_items": [{ "text": "...", "assignee": "..." }]
}
```
Each supported type has its own prompt template and JSON shape; new types can be
added by defining a new template + shape pair without touching the provider
implementations themselves (Claude/Ollama just execute whichever prompt they're
given).

- If neither provider is configured, transcript is still shown; summary/action
  items show a "Not generated — configure a provider" state.

## 7. Configuration

No settings screen. Configuration resolved in this precedence order:
1. Environment variables (e.g., `MEETING_NOTES_CLAUDE_API_KEY`,
   `MEETING_NOTES_OLLAMA_ENDPOINT`, `MEETING_NOTES_WHISPER_MODEL`)
2. Config file — `~/.config/meeting-notes/config.toml`
3. First-launch setup dialog — shown only if neither of the above is found;
   asks for Claude API key (optional), Ollama endpoint (optional), whisper model
   (default preselected). Fully skippable — app still works local-only (no
   summary/action items) if skipped.

## 8. Frontend — Floating Recorder Widget

**Window (Tauri config):**
- Transparent, always-on-top, frameless/borderless. Window size and chrome are
  **state-dependent** rather than fixed:
  - Idle / Done: ~400×300px card with a custom draggable title bar.
  - Recording: the window shrinks to a small pill (~224×56px) with **no title
    bar or card chrome at all** — just the floating docket (pulsing indicator,
    timer, compact waveform, icon-only stop button) on transparent space,
    draggable by its own body.
  - Processing: same chrome-less pill treatment, slightly wider (~260×56px) —
    spinner + status text, plus a compact provider picker (Claude/Ollama) once
    summarization actually starts and more than one provider is configured.
  This matches Notion's own recording/processing indicators rather than
  looking like a shrunken dialog at any point before the meeting is done.
- This widget **is** the entire app UI for this MVP — no navigation, no meeting
  list.

**Visual language:** modernized beyond shadcn's bare defaults — a defined
spacing scale, refined typography (weight/size hierarchy for title vs. body vs.
metadata text), subtle elevation/shadow on the floating card, and small
transition/motion cues between states so it doesn't feel like a raw
component-library scaffold.

**States:**
1. **Idle** — "Start Recording" button, optional meeting title input (defaults
   to timestamp), **meeting type selector** (Standup / Retrospective / Feature
   Request / Incident / Auto-detect, defaulting to Auto-detect).
2. **Recording** — live waveform (Web Audio API `AnalyserNode`, styled per
   reference image: dot-based reactive waveform), elapsed timer, "Stop Recording"
   button.
3. **Processing** — sequential status text ("Transcribing…" → "Generating
   summary…") with spinner/progress indicator, and a **provider picker** (Claude
   / Ollama, defaulting to the auto-selected provider) shown once transcription
   completes and before summarization is triggered.
4. **Done** — attendees list, summary content in the Notion-style or
   type-specific structure (whichever applies), action items as a checklist
   (shadcn `Checkbox`, each showing an assignee when identified), a
   **"Regenerate with [other provider]"** action, "Save & Close" / "New
   Recording" actions, and an expandable/linked "View Transcript" (secondary,
   not the widget's main focus).

**State management:** simple hooks + Tauri `invoke` calls; no need for a state
library at this scope.

## 9. Error Handling & Edge Cases

- No system audio monitor source → mic-only fallback, applied silently — the
  compact Recording pill (Section 8) has no room for a warning badge without
  breaking its minimal Notion-style form, so this is tracked internally
  (`used_system_audio` on `MeetingMeta`) rather than surfaced during recording.
- Recording interrupted → partial audio preserved, resumable on next launch.
- Transcription failure (binary missing/crash) → error state with "Retry"; audio
  file always preserved.
- Summary generation failure (no key/Ollama down/network error) → transcript
  still shown; summary/action items show "Not generated" with a link back to the
  config dialog.
- Long recordings (1hr+) → async/non-blocking; user can minimize while
  processing continues.

## 10. Testing Strategy

- **Rust backend:** unit tests for audio mixing logic, whisper.cpp output
  parsing, and `SummaryProvider` implementations (mockable).
- **Audio capture:** manual/integration testing on real hardware — both the
  Linux PipeWire stack and macOS ScreenCaptureKit permission/capture behavior
  vary enough by machine/OS version that full automation isn't practical for
  MVP; platform-specific modules are tested manually on their respective OS.
- **Frontend:** component tests for widget state transitions (idle → recording →
  processing → done).

## 11. Future Directions (explicitly deferred)

- Speaker diarization (audio-based; dual-track audio capture lays the
  groundwork — text-based attendee inference is in scope now, see Section 6)
- Due dates on action items (assignee is in scope now; due date still deferred)
- Meeting list/history UI (data model via `index.json` already supports this)
- Meeting-platform bot integration (Zoom/Meet API — join call, capture
  server-side)
- Windows support
- Settings screen (once config surface grows beyond first-launch scope)
- Editable/correctable attendees and action items in the Done state (manual
  fix-up when the LLM's text-based inference gets a name wrong)
- Export summary as Markdown/copy-to-clipboard in Notion-pasteable format
- User-defined custom meeting types beyond the built-in set
