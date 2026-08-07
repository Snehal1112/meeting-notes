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

## Prerequisites

Tested on Ubuntu 24.04 with PipeWire. Other Linux/PipeWire distros should work
but aren't verified.

1. **Rust** (1.75+) via [rustup](https://rustup.rs):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.sh | sh
   ```
2. **Node.js** (18+) — via your distro's package manager or
   [nvm](https://github.com/nvm-sh/nvm).
3. **bun** (1.1+):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
4. **Tauri's Linux system dependencies:**
   ```bash
   sudo apt update
   sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```
   If `libwebkit2gtk-4.1-dev` isn't available on your Ubuntu version, check
   `apt-cache search libwebkit2gtk` for the version it ships (e.g. `4.0` on
   older releases) and substitute it.
5. **PipeWire audio tooling** — `pw-record` (audio capture) and, ideally,
   `pactl` from `pulseaudio-utils` (device listing/selection):
   ```bash
   sudo apt install -y pipewire-utils pulseaudio-utils
   ```
   If `pactl` is unavailable, native tools like `wpctl status` / `pw-cli` work
   as a substitute for inspecting sources/sinks.
6. **whisper.cpp**, built from source, plus a downloaded model:
   ```bash
   git clone --depth 1 https://github.com/ggerganov/whisper.cpp
   cd whisper.cpp
   cmake -B build
   cmake --build build --config Release -j"$(nproc)"
   bash ./models/download-ggml-model.sh base.en
   ```
   The app looks for the `whisper-cli` binary on `PATH` by default (override
   with `MEETING_NOTES_WHISPER_BIN`), and expects the model at
   `models/ggml-<model>.bin` relative to its working directory, where
   `<model>` is set via `MEETING_NOTES_WHISPER_MODEL` (e.g. `base.en`).
7. **An LLM provider** for summarization — pick one:
   - **Claude API** — an API key set via `MEETING_NOTES_CLAUDE_API_KEY`.
   - **[Ollama](https://ollama.com)**, running locally with a model pulled
     (e.g. `ollama pull llama3`); point the app at it by setting
     `MEETING_NOTES_OLLAMA_ENDPOINT` (e.g. `http://localhost:11434` — required,
     no built-in default).

   Neither is required to run the app — skip both and it still records and
   transcribes locally, just without a generated summary/action items.

## Development

Package manager is [bun](https://bun.sh).

```bash
bun install         # install JS dependencies
bun run tauri dev   # run the app (Tauri window + Vite dev server)
bun run build         # typecheck + build the frontend
bun run tauri build # produce a native app bundle
```

Rust backend (from `src-tauri/`):

```bash
cargo build   # compile the Tauri binary crate
cargo test    # run Rust unit tests
cargo check   # fast typecheck
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
