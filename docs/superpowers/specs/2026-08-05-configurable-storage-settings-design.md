# Configurable Storage Location & Reopenable Settings Panel — Design Spec

**Date:** 2026-08-05
**Status:** Approved, ready for implementation (Plan 25)
**Depends on:** The real, currently-running app — `TitleBar.tsx`, `ConfigDialog.tsx`,
`App.tsx`, and the real `Config` struct (`claude_api_key`, `ollama_endpoint`,
`ollama_model`, `ollama_num_ctx`, `summary_provider`, `whisper_model`).

> This is a scoped design doc for one feature, split out from the main project
> design doc's Section 10.6 at the same level of detail that section already
> covers, plus the corrections found while scoping it. The main design doc
> remains the source of truth for the project as a whole; this exists so the
> feature has its own self-contained reference alongside `docs/superpowers/plans/2026-08-03-25-configurable-storage-settings.md`.

## 1. Problem & Goals

Two gaps existed before this feature:

1. **Settings could only be set once**, at first launch. There was no way to
   change an API key, endpoint, or model choice afterward without manually
   editing `config.toml` by hand.
2. **Storage location wasn't configurable at all.** It was hardcoded to
   whatever `directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")`
   resolves to on the OS (e.g. `~/.local/share/meeting-notes` on Linux) — no
   override existed anywhere in `Config`.

**Goals:**
- A gear icon, always visible in the title bar, reopens the same settings UI
  used at first launch — now pre-filled with current values, genuinely
  editable rather than a one-shot setup flow.
- Storage location becomes a real config field, changeable via a native
  folder picker.
- Changing storage location when the current one already has meetings never
  silently loses or hides them — the user is always told how many exist and
  given an explicit choice.

## 2. Constraints Carried From the Real App (found during scoping, not assumptions)

These aren't new decisions — they're facts about the existing app that this
feature has to work within, discovered via project knowledge and a real
screenshot during scoping:

- **`ConfigDialog` is deliberately an inline panel, not a modal `Dialog`.**
  The real component renders via `if (!open) return null` directly in the
  layout flow. This is intentional: a real modal's overlay and
  outside-click-to-dismiss behavior would conflict with the widget's
  always-on-top, draggable, borderless window — a drag gesture starting
  inside the window but ending outside it could register as an
  outside-click and dismiss the dialog mid-drag. Every UI addition in this
  feature (the Storage Location field, the migration warning) follows the
  same inline-panel pattern, never a second modal layered on top.
- **The title bar already has a close (X) button**, confirmed via a real
  screenshot — centered drag-dots, close button on the right. This wasn't
  visible in any earlier text-based reconstruction and an earlier draft of
  this plan incorrectly omitted it. The gear icon goes on the **left**,
  mirroring the close button on the right, dots staying centered between
  them.
- **`TitleBar.tsx` has its own drag-region fallback** — an
  `onMouseDown`/`getCurrentWindow().startDragging()` handler working around
  a WebKitGTK/Linux bug where `data-tauri-drag-region` alone doesn't
  reliably start a window drag. This must survive untouched; the gear and
  close buttons both call `e.stopPropagation()` on `onClick` and
  `onMouseDown` so they don't trigger it.
- **Typography is monospace app-wide** (confirmed via the same screenshot),
  not Inter-for-prose/monospace-for-timer as an earlier design pass assumed.
  Any new UI text in this feature inherits the existing monospace styling —
  nothing in this feature introduces a font choice of its own.
- **Every interactive element must be a real shadcn component**, not raw
  HTML — established as a hard rule across the whole redesign effort. The
  gear/close icons use `<Button variant="ghost" size="icon">` (shadcn's real
  component, sized down via className from its default `h-9 w-9` to `h-6
  w-6`), the same pattern already used for the Recording pill's stop
  button. The Storage Location "Change…" button and the migration warning's
  Move/Leave/Cancel buttons all use shadcn `<Button>` with existing variants
  (`outline`, `ghost`) — no new variant needed, unlike the Done state's
  `success` variant which required extending `button.tsx` itself.

## 3. Architecture

### 3.1 Config field

```rust
pub struct Config {
    // ... existing real fields ...
    pub data_dir: Option<String>,
}
```

`None` means "use the OS-standard default." Existing `config.toml` files
without this field deserialize fine — same optional-field pattern already
used for every other `Config` field.

### 3.2 base_dir() becomes override-aware

Previously a zero-argument function always resolving via `ProjectDirs`. Now:

```rust
pub fn base_dir(override_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        return Some(dir.to_path_buf());
    }
    directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")
        .map(|dirs| dirs.data_dir().to_path_buf())
}
```

Deliberately **not** reading config internally — the storage crate stays
free of implicit config-resolution side effects. Every Tauri command that
calls `base_dir()` is responsible for calling `resolve_config()` itself and
passing `config.data_dir.map(PathBuf::from).as_deref()` in explicitly. This
touches every existing command that previously called `base_dir()` bare
(`storage_commands.rs`, `summary_commands.rs`, `transcription_commands.rs`).

### 3.3 Settings reopen flow

No new state machine — `App.tsx` already has `showConfigDialog: boolean`
(from `configNeedsSetup()` at first launch). The gear icon just sets that
same boolean `true` on demand:

```
Gear icon click → setShowConfigDialog(true) → ConfigDialog renders with
current values pre-filled (via useEffect reading getCurrentDataDir() etc.
on open) → Save persists, Skip/close discards changes and hides the panel
```

Since the gear icon lives in `TitleBar`, and `TitleBar` only renders during
the Idle state's full chrome (Recording/Processing are chrome-less pills
with no title bar at all), Settings is structurally only reachable when
idle — no explicit guard needed to prevent opening it mid-recording.

### 3.4 Migration flow

```
User clicks "Change…" on Storage Location
  → native OS folder picker opens (tauri-plugin-dialog; NOT an in-app
    dialog, so it doesn't interact with the inline-panel-not-modal
    constraint at all — it's outside the app's own DOM/window)
  → user picks a folder
  → count_meetings_at(current_location) checked
  → if count > 0: inline amber warning box appears within the same
    ConfigDialog panel, showing the exact count and three choices:
      - "Move them"   → migrate_meetings(from, to) — see 3.5
      - "Leave them"  → just adopt the new path, old files untouched on disk
      - "Cancel"      → discard the picked folder, keep current location
  → if count == 0: new location adopted immediately, no warning needed
  → data_dir is persisted as part of the normal handleSave() flow alongside
    every other field — there's no separate "save location" action
```

### 3.5 Move semantics

`migrate_meetings(from, to)`:
- Moves every entry under `{from}/meetings/` to `{to}/meetings/` via
  `fs::rename`
- **Merges** `index.json` rather than overwriting — reads both locations'
  indices, keeps every entry from `to` as-is, appends any entry from `from`
  whose `id` doesn't already exist at `to`. This matters because the user
  might be switching back to a previously-used folder that already has its
  own meetings; a naive overwrite would silently lose them.
- Known edge case, not specially handled: if a meeting `id` somehow collides
  between the two locations (astronomically unlikely given IDs are
  timestamp-derived), the `to` location's entry silently wins. Acceptable
  for this pass; revisit only if it's ever observed in practice.

## 4. UI Surface

**Title bar (Idle state only):**
```
[gear icon]  •  •  •  [close X]
```
Gear and close are both `Button variant="ghost" size="icon"` at `h-6 w-6`,
positioned at opposite ends with the drag-dots centered between them.

**Settings panel (extends the existing ConfigDialog inline panel):**
- Existing fields unchanged: Claude API Key, Ollama Endpoint, Ollama Model,
  Ollama num_ctx, Summarize With (provider default), Whisper Model
- New: **Storage Location** — current path (truncated, monospace) +
  "Change…" button (`Button variant="outline" size="sm"`)
- New, conditional: the amber migration-warning box, only visible between
  picking a new folder and resolving the Move/Leave/Cancel choice

## 5. What This Explicitly Does Not Do

- Does not add a settings *screen* separate from `ConfigDialog` — extends
  the existing component per the confirmed decision, not a parallel UI.
- Does not persist "last meeting" or any Done-state-adjacent feature — that
  belongs to Plan 24, unrelated to this one.
- Does not validate that the picked folder is writable before offering it as
  a destination — a `migrate_meetings` failure (e.g. permission denied)
  surfaces as a plain error string from the Tauri command; no dedicated
  pre-flight check. Worth a fast-follow if this proves to be a real papercut
  in practice, not blocking for this pass.
- Does not support undo after a successful "Move them" — the operation is a
  real filesystem move, not a copy. If this needs to be reversible later,
  that's a copy-then-verify-then-delete-original redesign, not a small
  addition to what's here.

## 6. Testing

- **Rust:** `base_dir()` override vs. default-fallback behavior (unit
  tested); `migrate_meetings`'s merge-by-id logic deserves a test with
  overlapping and non-overlapping index entries, not just the happy path
  shown in the plan's illustrative code.
- **Manual, on real hardware (not yet done as of this writing — same caveat
  as every other plan in this project: no live `bun run tauri dev` walkthrough
  has occurred in the environment these plans were scoped in):**
  - Gear icon opens Settings with real current values, not blanks
  - Dragging the title bar by the dot area still works after the gear/close
    layout change
  - The close button's existing behavior is unaffected
  - Changing location with zero existing meetings vs. with several — both
    paths, confirming the warning only appears when it should
  - "Move them" actually relocates files and the app reads correctly from
    the new location afterward
  - "Leave them" leaves old files genuinely untouched on disk
