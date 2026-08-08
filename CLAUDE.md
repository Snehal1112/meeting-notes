# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A small, always-on-top floating desktop widget (Tauri + Rust + React/TypeScript) that
records a live meeting's audio (mic + system audio) on Linux (Ubuntu, PipeWire),
transcribes it locally with whisper.cpp, and generates a summary + flat action-item
list via a pluggable LLM provider (Claude API or local Ollama). Standalone
portfolio/MVP project, Linux-only for now — see
`docs/superpowers/specs/2026-08-01-meeting-notes-widget-design.md` for the full
design spec (architecture, data storage layout, config precedence, error handling,
explicitly out-of-scope items).

**Current state:** past the scaffold stage. `src/App.tsx` is real
window-orchestration/resume/config/history code (not the stock greet demo), backed
by 15+ components under `src/components/`, and `src-tauri` has already been split
into the Cargo workspace crates described below. This file describes stable
architectural facts (frameworks, layering, storage/config precedence) rather than
an exact feature checklist — for what's actually implemented vs. still planned,
check `docs/superpowers/plans/` (each plan file reflects its own completion state)
and recent `git log` history, since that drifts independently of this doc.

**Build plan:** `docs/superpowers/plans/` contains a numbered sequence of
implementation plans meant to be executed in order via the
`superpowers:executing-plans` or `superpowers:subagent-driven-development` skills.
Check this directory (and `git log`) before starting new feature work — a given
plan, including plan 01's Cargo-workspace restructuring, may already be done, and
this doc will not be kept in sync with that per-plan progress. `ls crates/` shows
the current set of library crates directly rather than relying on this doc to
enumerate them.

## Commands

Package manager is **bun** (`bun.lock` present; `tauri.conf.json` invokes
`bun run dev` / `bun run build`).

```bash
bun install              # install JS deps
bun run dev              # Vite dev server only (frontend, no Tauri window)
bun run tauri dev        # full app: Tauri window + Vite dev server (port 1420, fixed)
bun run build             # tsc typecheck + vite build
bun run tauri build      # produce native app bundle
bun run preview          # preview a production Vite build
```

Rust backend (`src-tauri/`), run from that directory:

```bash
cargo build               # compile the Tauri binary crate
cargo test                # run Rust unit tests
cargo check                # fast typecheck
```

There is no lint script configured yet. TypeScript strictness (`strict`,
`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`) is enforced
via `tsc` as part of `bun run build`.

## Architecture

- **Frontend** (`src/`): React 19 + TypeScript, built with Vite. The window is a
  small frameless widget: `src-tauri/tauri.conf.json` sets 400×300 (resizable,
  `decorations: false`, `transparent: true`), with a custom draggable `TitleBar`
  component. `alwaysOnTop` is deliberately *not* set in that static config —
  `src-tauri/src/lib.rs`'s `.setup()` applies it at runtime shortly after first
  paint, working around a Mutter/Wayland stacking bug — so read `tauri.conf.json`
  plus that setup hook together, not the config file alone, to see the real
  window behavior. Frontend calls into Rust via `@tauri-apps/api`'s `invoke()`.
- **Backend** (`src-tauri/`): Rust, Tauri v2. `src-tauri/src/main.rs` is a thin
  binary entry point (currently ~12 lines: a Linux/Wayland GDK-backend
  workaround, then a call into `meeting_notes_lib::run()`) — it does not itself
  register anything. `src-tauri/src/lib.rs` is where `run()` lives: plugin
  registration, the `.setup()` hook (webview permissions, tray icon, mic
  watcher), and the full `invoke_handler(tauri::generate_handler![...])` list of
  `#[tauri::command]`s. Business logic lives in separate library crates under
  `crates/` (`ls crates/` for the current list — e.g. `meeting-notes-core`,
  `meeting-notes-audio`, `meeting-notes-transcription`, `meeting-notes-summary`,
  `meeting-notes-storage` as of this writing) rather than directly in
  `src-tauri`, mirroring a DDD-style separation by responsibility (audio
  capture, transcription, summary/LLM providers, storage); `src-tauri/src/`
  itself is now mostly thin Tauri-command wrappers (`src-tauri/src/commands/`)
  around those crates.
- **Capabilities** (`src-tauri/capabilities/default.json`): Tauri v2's permission
  system — grants the `main` window `core:default` + `opener:default`. New Tauri
  commands/plugins that need elevated permissions must be added here.
- **Core flow** (implemented): Start Recording → Rust captures mic (+ system
  audio where available) via PipeWire (`crates/meeting-notes-audio`) → Stop →
  audio saved into the meeting's directory → whisper.cpp
  (`crates/meeting-notes-transcription`, shelling out to a `whisper-cli` binary)
  transcribes to `transcript.txt` (plus a raw JSON) → transcript sent to the
  configured `SummaryProvider` (Claude API or Ollama, behind a shared Rust trait
  in `crates/meeting-notes-summary`) → `summary.md`, `action_items.json`, and
  `summary_result.json` are written into the same meeting directory and the
  meeting's status is updated in the index. See
  `src-tauri/src/commands/{recording,transcription,summary}_commands.rs` for the
  exact Tauri-command-level orchestration, which is the authoritative source for
  this flow going forward (this doc gives the general shape, not a line-by-line
  trace).
- **Data storage** (implemented, `crates/meeting-notes-storage`): an OS-standard
  data directory (`~/.local/share/meeting-notes/` on Linux, overridable via
  config) holding a top-level `index.json` (meeting metadata index) and a
  `meetings/<id>/` directory per meeting (id = timestamp + title slug) with that
  meeting's audio, transcript, and summary files. Read
  `crates/meeting-notes-storage/src/lib.rs` for the exact on-disk file set and
  index-write semantics (e.g. atomic temp-file-then-rename) rather than treating
  any filename list here as exhaustive, since new per-meeting files can be added
  without changing this doc.
- **Configuration** (implemented, `crates/meeting-notes-core/src/config`):
  resolved as environment variables (`MEETING_NOTES_CLAUDE_API_KEY`,
  `MEETING_NOTES_OLLAMA_ENDPOINT`, `MEETING_NOTES_WHISPER_MODEL`, and others —
  see `Config::from_env` for the full set) merged over a config file
  (`~/.config/meeting-notes/config.toml`, env values win). The `ConfigDialog`
  frontend component writes to that same file and is shown at first launch when
  `config_needs_setup` reports no provider is configured; it's skippable and
  there's no separate settings screen beyond it.
