# Meeting Notes Widget — Design Spec

**Date:** 2026-08-01
**Status:** Approved
**Author:** Snehal Dangroshiya

## 1. Overview & Goals

A small, always-on-top floating desktop widget (Tauri + Rust + React/TypeScript +
shadcn/ui) that records a live meeting's audio (mic + system audio) on Linux
(Ubuntu, PipeWire), transcribes it locally with whisper.cpp, and generates a
summary + flat action-item list via a pluggable LLM provider (Claude API or local
Ollama).

**Positioning:** standalone product/self-hostable tool, portfolio project, and MVP
to validate the concept — not tied to NumericLabs/NHe4a.

**Explicitly out of scope for this MVP:**
- Speaker diarization / identification
- Structured action items (assignee, due date)
- Meeting list / history browser UI
- Settings screen (replaced by first-launch config dialog + config file/env vars)
- macOS / Windows support (Linux/Ubuntu only for now)
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

- `index.json`: array of meeting metadata (title, date, duration, status) — even
  though there's no list UI in this MVP, this keeps a record on disk and makes a
  future list view a pure UI addition, not a data-model change.
- `transcript.json`: array of `{ start_time, end_time, text }` segments — kept
  even without diarization so a future speaker field can be added without a
  format change.
- `action_items.json`: array of `{ id, text, completed }`.

## 4. Audio Capture (Rust backend)

- PipeWire on Ubuntu 22.04+ — capture **mic input** and **system audio (monitor
  source)** simultaneously, mixed into a single `audio.wav`.
- Implementation: `pipewire-rs` crate, with `parec`/`pw-record` shell-out as a
  simpler v1 fallback if the crate proves heavy. Mixing done via basic sample
  summing; written out via the `hound` crate.
- Dual-track (separate mic/system files) deferred — noted as the natural
  foundation for future speaker diarization.

**Failure handling:**
- No monitor source found → fall back to mic-only, show a warning badge in the
  widget ("System audio unavailable — recording mic only").
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
- Provider selection is a user setting (config file/env var/first-launch dialog),
  transparent to the UI.
- Expected LLM output contract:
  ```json
  {
    "summary": "...",
    "action_items": ["...", "..."]
  }
  ```
  Deliberately simple — no assignee/due-date extraction in this MVP (fast-follow).
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
- Small fixed size (~400×300px), always-on-top, frameless/borderless with a
  custom draggable title bar.
- This widget **is** the entire app UI for this MVP — no navigation, no meeting
  list.

**States:**
1. **Idle** — "Start Recording" button, optional meeting title input (defaults to
   timestamp).
2. **Recording** — live waveform (Web Audio API `AnalyserNode`, styled per
   reference image: dot-based reactive waveform), elapsed timer, "Stop Recording"
   button.
3. **Processing** — sequential status text ("Transcribing…" → "Generating
   summary…") with spinner/progress indicator.
4. **Done** — compact summary (scrollable), action items as a checklist
   (shadcn `Checkbox`), "Save & Close" / "New Recording" actions, and an
   expandable/linked "View Transcript" (secondary, not the widget's main focus).

**State management:** simple hooks + Tauri `invoke` calls; no need for a state
library at this scope.

## 9. Error Handling & Edge Cases

- No system audio monitor source → mic-only fallback + warning badge.
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
- **Audio capture:** manual/integration testing on real hardware — Linux audio
  stack (PipeWire config) varies enough that full automation isn't practical for
  MVP.
- **Frontend:** component tests for widget state transitions (idle → recording →
  processing → done).

## 11. Future Directions (explicitly deferred)

- Speaker diarization (dual-track audio capture lays the groundwork)
- Structured action items (assignee, due date)
- Meeting list/history UI (data model via `index.json` already supports this)
- Meeting-platform bot integration (Zoom/Meet API — join call, capture
  server-side)
- macOS/Windows support
- Settings screen (once config surface grows beyond first-launch scope)
