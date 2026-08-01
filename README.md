# Meeting Notes

A small, always-on-top floating desktop widget (Tauri + Rust + React/TypeScript)
that records a live meeting's audio (mic + system audio) on Linux (Ubuntu,
PipeWire), transcribes it locally with whisper.cpp, and generates a summary +
flat action-item list via a pluggable LLM provider (Claude API or local Ollama).

Standalone/self-hostable portfolio project — Linux/Ubuntu only for this MVP, not
tied to any particular organization.

> **Status:** early scaffold. The design is specced out but not yet built — see
> `docs/superpowers/specs/2026-08-01-meeting-notes-widget-design.md` for the full
> spec and `docs/superpowers/plans/` for the implementation plan.

## How it works

1. Click "Start Recording" in the floating widget — the Rust backend captures
   mic + system audio (mixed) via PipeWire.
2. Click "Stop" — audio is saved to disk as `audio.wav`.
3. whisper.cpp transcribes the recording locally into a timestamped transcript.
4. The transcript is sent to the configured LLM provider (Claude API or Ollama),
   which returns a summary and a flat action-item list.
5. The widget displays the summary and action items inline; everything is
   persisted to local files.

**Explicitly out of scope for this MVP:** speaker diarization, structured action
items (assignee/due date), a meeting list/history UI, a settings screen, macOS/
Windows support, and meeting-platform bot integration (Zoom/Meet).

## Data storage

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

## Configuration

No settings screen. Configuration is resolved in this order:

1. Environment variables — `MEETING_NOTES_CLAUDE_API_KEY`,
   `MEETING_NOTES_OLLAMA_ENDPOINT`, `MEETING_NOTES_WHISPER_MODEL`
2. Config file — `~/.config/meeting-notes/config.toml`
3. First-launch setup dialog — shown only if neither of the above is found;
   fully skippable, the app still works local-only (no summary/action items) if
   skipped.

## Tech stack

Tauri v2, Rust, React 19, TypeScript, Vite, shadcn/ui.

## Development

Package manager is [bun](https://bun.sh).

```bash
bun install         # install JS dependencies
bun run tauri dev   # run the app (Tauri window + Vite dev server)
bun run build         # typecheck + build the frontend
bun run tauri build # produce a native app bundle
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
