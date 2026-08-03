# Project Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Prerequisite:** Plan 00 (Environment Setup & Toolchain Verification) must be complete before starting this plan. It confirms Tauri build prerequisites are installed and records the exact tool versions used in `docs/superpowers/specs/environment.md`.

**Goal:** Stand up a Tauri + React/TypeScript project with shadcn/ui installed and a floating, always-on-top, frameless recorder window shell.

**Architecture:** Standard Tauri v2 scaffold (`create-tauri-app`) with React + TypeScript template, restructured into a **Cargo workspace**: `src-tauri` becomes a thin binary crate (commands + wiring only), with all business logic split across library crates under `crates/` by responsibility — mirroring the DDD-style separation used in RocketAPI. shadcn/ui added via its CLI. The main window is reconfigured in `tauri.conf.json` to be small, frameless, always-on-top, and draggable via a custom title bar region.

**Tech Stack:** Tauri v2, Rust (Cargo workspace), React 18, TypeScript, Vite, shadcn/ui, Tailwind CSS

> **Cross-platform note:** This plan (and plans 02–12) build out the Linux implementation. macOS support is added afterward via plans 13–16 (toolchain/permissions verification, audio facade refactor, ScreenCaptureKit-based capture, and bundle configuration) — the crate structure created here (`meeting-notes-audio` as its own crate) is what makes that addition possible without touching the other crates.

**Workspace crates (created in this plan, filled in by later plans):**
- `meeting-notes-core` — shared domain types & traits (`Config`, `MeetingMeta`, `TranscriptSegment`, `SummaryResult`, `SummaryProvider` trait). Every other crate depends on this one; it depends on nothing project-specific.
- `meeting-notes-audio` — PipeWire capture + WAV mixing (plans 04–05)
- `meeting-notes-transcription` — whisper.cpp integration (plan 08) — depends on `meeting-notes-core`
- `meeting-notes-summary` — Claude/Ollama provider implementations (plans 09–10) — depends on `meeting-notes-core`
- `meeting-notes-storage` — meeting directories + `index.json` (plan 07) — depends on `meeting-notes-core`
- `src-tauri` — binary crate: Tauri commands only, depends on all of the above

---

### Task 1: Scaffold Tauri + React/TypeScript project as a Cargo workspace

**Files:**
- Create: `meeting-notes/` (entire project via CLI)
- Create: `meeting-notes/Cargo.toml` (workspace root)
- Create: `meeting-notes/crates/meeting-notes-core/Cargo.toml` + `src/lib.rs`
- Create: `meeting-notes/crates/meeting-notes-audio/Cargo.toml` + `src/lib.rs`
- Create: `meeting-notes/crates/meeting-notes-transcription/Cargo.toml` + `src/lib.rs`
- Create: `meeting-notes/crates/meeting-notes-summary/Cargo.toml` + `src/lib.rs`
- Create: `meeting-notes/crates/meeting-notes-storage/Cargo.toml` + `src/lib.rs`
- Modify: `meeting-notes/src-tauri/Cargo.toml`
- Modify: `meeting-notes/src-tauri/tauri.conf.json`

- [ ] **Step 1: Scaffold the project**

```bash
bun create tauri-app meeting-notes --template react-ts --manager bun
cd meeting-notes
bun install
```

- [ ] **Step 2: Verify the default app builds and runs**

Run: `bun run tauri dev`
Expected: default Tauri window opens showing the template's Vite + React starter page, no errors in terminal.

- [ ] **Step 3: Create the crates/ directory with five library crate skeletons**

```bash
mkdir -p crates
for name in core audio transcription summary storage; do
  cargo new --lib "crates/meeting-notes-$name"
done
```

Each generated crate gets a trivial placeholder in its `src/lib.rs` for now (later plans replace these):

```rust
// crates/meeting-notes-core/src/lib.rs (and similarly for the other four crates)
// Filled in by later plans.
```

- [ ] **Step 4: Add inter-crate dependencies**

`meeting-notes-audio`, `meeting-notes-transcription`, `meeting-notes-summary`, and `meeting-notes-storage` each depend on `meeting-notes-core` for shared types. Add to each of their `Cargo.toml` (except core's own):

```toml
[dependencies]
meeting-notes-core = { path = "../meeting-notes-core" }
```

- [ ] **Step 5: Convert the root into a Cargo workspace**

Create `Cargo.toml` at the project root (sibling to `src-tauri/`, not inside it):

```toml
[workspace]
resolver = "2"
members = [
    "src-tauri",
    "crates/meeting-notes-core",
    "crates/meeting-notes-audio",
    "crates/meeting-notes-transcription",
    "crates/meeting-notes-summary",
    "crates/meeting-notes-storage",
]
```

- [ ] **Step 6: Add the five crates as dependencies of src-tauri**

In `src-tauri/Cargo.toml`, add under `[dependencies]`:

```toml
meeting-notes-core = { path = "../crates/meeting-notes-core" }
meeting-notes-audio = { path = "../crates/meeting-notes-audio" }
meeting-notes-transcription = { path = "../crates/meeting-notes-transcription" }
meeting-notes-summary = { path = "../crates/meeting-notes-summary" }
meeting-notes-storage = { path = "../crates/meeting-notes-storage" }
```

- [ ] **Step 7: Verify the workspace builds**

Run: `cargo build --workspace` (from the project root)
Expected: all six crates (`src-tauri` + five library crates) compile successfully with no errors.

- [ ] **Step 8: Commit initial scaffold**

```bash
git init
git add .
git commit -m "chore: scaffold Tauri + React/TypeScript project as a Cargo workspace"
```

---

### Task 2: Install and configure shadcn/ui

**Files:**
- Modify: `meeting-notes/tailwind.config.js`
- Modify: `meeting-notes/src/index.css`
- Create: `meeting-notes/components.json`
- Create: `meeting-notes/src/lib/utils.ts`

- [ ] **Step 1: Install Tailwind CSS**

```bash
bun add -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

Update `tailwind.config.js` `content` array to `["./index.html", "./src/**/*.{ts,tsx}"]`.

- [ ] **Step 2: Initialize shadcn/ui**

```bash
npx shadcn@latest init
```

When prompted: TypeScript = yes, style = default, base color = slate, CSS variables = yes.

- [ ] **Step 3: Add the components this project will need**

```bash
npx shadcn@latest add button checkbox tabs input dialog select
```

Verify `src/components/ui/` contains `button.tsx`, `checkbox.tsx`, `tabs.tsx`, `input.tsx`, `dialog.tsx`, `select.tsx`.

- [ ] **Step 4: Verify a shadcn component renders**

Temporarily import `Button` from `@/components/ui/button` into `src/App.tsx`, run `bun run tauri dev`, confirm styled button appears. Revert the temporary import.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: install and configure shadcn/ui"
```

---

### Task 3: Configure the floating, always-on-top window

**Files:**
- Modify: `meeting-notes/src-tauri/tauri.conf.json`
- Modify: `meeting-notes/src/App.tsx`
- Create: `meeting-notes/src/components/TitleBar.tsx`

- [ ] **Step 1: Update window config**

In `src-tauri/tauri.conf.json`, set the main window block:

```json
{
  "app": {
    "windows": [
      {
        "title": "Meeting Notes",
        "width": 400,
        "height": 300,
        "resizable": false,
        "alwaysOnTop": true,
        "decorations": false,
        "transparent": true,
        "skipTaskbar": false
      }
    ]
  }
}
```

Note: `transparent: true` means the OS-level window itself has no background — every visible surface (the card, the title bar) must paint its own opaque background via CSS (already the plan, e.g. `bg-background` on the root div in later steps). This is what makes it possible for the Recording state (styled in plan 20) to shrink the window down to a borderless floating pill with nothing but transparent space around it, matching how Notion's own recording indicator behaves — without it, a resized-but-opaque window would just show as a small white rectangle instead of a true floating pill.

- [ ] **Step 2: Add a draggable custom title bar component**

```tsx
// src/components/TitleBar.tsx
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="h-8 flex items-center px-3 text-xs text-muted-foreground select-none border-b"
    >
      Meeting Notes
    </div>
  );
}
```

- [ ] **Step 3: Mount the title bar in App.tsx**

```tsx
// src/App.tsx
import { TitleBar } from "@/components/TitleBar";

function App() {
  return (
    <div className="h-screen flex flex-col rounded-lg overflow-hidden border">
      <TitleBar />
      <div className="flex-1 p-4">{/* widget content goes here */}</div>
    </div>
  );
}

export default App;
```

- [ ] **Step 4: Verify window behavior**

Run: `bun run tauri dev`
Expected: small 400x300 frameless window, stays on top of other windows, draggable by the title bar region.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: configure floating always-on-top draggable window shell"
```
