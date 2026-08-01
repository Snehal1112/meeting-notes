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

**Current state:** the repo is still the default `create-tauri-app` scaffold
(`src/App.tsx` is the stock Vite+React+Tauri greet demo). None of the app-specific
features described in the spec are implemented yet.

**Build plan:** `docs/superpowers/plans/` contains a numbered sequence of
implementation plans (00 environment setup → 12 error handling/recovery) meant to
be executed in order via the `superpowers:executing-plans` or
`superpowers:subagent-driven-development` skills. Check this directory before
starting new feature work — it may already be specced out, including target file
layout. Plan 01 in particular calls for restructuring `src-tauri` into a Cargo
workspace with library crates under `crates/` (`meeting-notes-core`,
`meeting-notes-audio`, `meeting-notes-transcription`, `meeting-notes-summary`,
`meeting-notes-storage`) — this restructuring has not happened yet as of this
writing.

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

- **Frontend** (`src/`): React 19 + TypeScript, built with Vite. The window is
  configured in `src-tauri/tauri.conf.json` — per the design spec this should
  become a small (~400×300px), frameless, always-on-top widget with a custom
  draggable title bar (currently still the default 800×600 titled window).
  Frontend calls into Rust via `@tauri-apps/api`'s `invoke()`.
- **Backend** (`src-tauri/`): Rust, Tauri v2. `src-tauri/src/main.rs` is the binary
  entry point; `src-tauri/src/lib.rs` registers plugins and Tauri commands
  (`#[tauri::command]`) via `invoke_handler`. Per the plan, business logic should
  live in separate library crates under `crates/` (not yet created) rather than
  directly in `src-tauri`, mirroring a DDD-style separation by responsibility
  (audio capture, transcription, summary/LLM providers, storage).
- **Capabilities** (`src-tauri/capabilities/default.json`): Tauri v2's permission
  system — grants the `main` window `core:default` + `opener:default`. New Tauri
  commands/plugins that need elevated permissions must be added here.
- **Planned core flow** (not yet implemented): Start Recording → Rust captures
  mixed mic+system audio via PipeWire → Stop → `audio.wav` saved → whisper.cpp
  transcribes to `transcript.json`/`transcript.txt` → transcript sent to the
  configured `SummaryProvider` (Claude API or Ollama, behind a shared Rust trait)
  → summary + action items returned as JSON and persisted alongside the audio.
- **Planned data storage** (not yet implemented): `~/.local/share/meeting-notes/`
  with a top-level `index.json` (lightweight meeting metadata index) and a
  `meetings/<timestamp>_<slug>/` directory per meeting holding
  `audio.wav`, `transcript.json`, `transcript.txt`, `summary.md`,
  `action_items.json`.
- **Planned configuration** (not yet implemented): resolved in precedence order —
  environment variables (`MEETING_NOTES_CLAUDE_API_KEY`,
  `MEETING_NOTES_OLLAMA_ENDPOINT`, `MEETING_NOTES_WHISPER_MODEL`) → config file
  (`~/.config/meeting-notes/config.toml`) → first-launch setup dialog (skippable).
  No settings screen in this MVP.
