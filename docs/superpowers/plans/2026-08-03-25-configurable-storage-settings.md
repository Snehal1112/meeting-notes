# Configurable Storage Location & Reopenable Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan targets the REAL current codebase**, reconstructed from fragments visible in project knowledge — the real `Config` struct (`claude_api_key`, `ollama_endpoint`, `ollama_model`, `ollama_num_ctx`, `summary_provider`, `whisper_model` fields, confirmed via the real `ConfigDialog.tsx`'s `handleSave`), the real `ConfigDialog.tsx` (a conditionally-rendered inline panel — `if (!open) return null` — deliberately **not** a modal `Dialog`, because a real modal's overlay/outside-click-dismiss fights the always-on-top widget's draggable title bar), and the real `TitleBar.tsx` (which has its own `onMouseDown`/`getCurrentWindow().startDragging()` fallback for a WebKitGTK/Linux drag-region bug — do not delete this while adding the gear icon). Treat every code sample below as illustrative of intent, not a byte-exact diff.

**Goal:** Let the user change API keys, endpoints, and the meeting storage location at any time (not just at first launch) via a gear icon in the title bar that reopens the same `ConfigDialog` panel. Storage location becomes a real, previously-nonexistent config field (`data_dir`), backed by a native folder picker, with an explicit warn-and-choose flow when the current location already has meetings in it.

**Architecture:** `Config` gains an `data_dir: Option<String>` field. `meeting-notes-storage`'s `base_dir()` changes from a zero-argument function (always resolving via `directories::ProjectDirs`) to accepting the resolved config's override, falling back to the existing default when `None` — keeping the storage crate free of any implicit config-reading side effects, since the caller (a Tauri command) is responsible for resolving config and passing the override in explicitly. `ConfigDialog` gains an always-available reopen path (the gear icon) in addition to its existing first-launch trigger, and a new "Storage Location" section with a native folder picker (`tauri-plugin-dialog`) and an inline (not modal — consistent with this panel's existing architecture) confirmation step when the current location has existing meetings.

---

### Task 1: Config gets a data_dir override, base_dir() respects it, migration command

**Files:**
- Modify: `crates/meeting-notes-core/src/config.rs`
- Modify: `crates/meeting-notes-storage/src/lib.rs`
- Modify: `crates/meeting-notes-storage/src/tests.rs`
- Create: `src-tauri/src/commands/data_dir_commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add data_dir to Config**

```rust
// crates/meeting-notes-core/src/config.rs (add alongside the real existing
// fields: claude_api_key, ollama_endpoint, ollama_model, ollama_num_ctx,
// summary_provider, whisper_model)
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    // ... existing real fields, unchanged ...
    pub data_dir: Option<String>,
}
```

`#[serde(default)]`-equivalent behavior already applies here the same way it does for the other optional fields — existing `config.toml` files without `data_dir` deserialize fine, `None` means "use the OS-standard default."

- [ ] **Step 2: Write failing test for base_dir() respecting the override**

```rust
// crates/meeting-notes-storage/src/tests.rs (additions)
use std::path::PathBuf;

#[test]
fn base_dir_uses_explicit_override_when_provided() {
    let override_path = PathBuf::from("/tmp/custom-meeting-notes-location");
    let resolved = base_dir(Some(&override_path));
    assert_eq!(resolved, Some(override_path));
}

#[test]
fn base_dir_falls_back_to_default_when_no_override() {
    let resolved = base_dir(None);
    assert!(resolved.is_some()); // exact path is platform-dependent, just confirm it resolves
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p meeting-notes-storage base_dir -- --nocapture`
Expected: FAIL — `base_dir` doesn't currently accept an argument (verify its real current signature first; if it already takes `Option<&Path>` for some other reason, adapt this step rather than assuming it's zero-arg).

- [ ] **Step 4: Update base_dir's signature**

```rust
// crates/meeting-notes-storage/src/lib.rs (modify)
use std::path::{Path, PathBuf};

pub fn base_dir(override_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        return Some(dir.to_path_buf());
    }
    directories::ProjectDirs::from("com", "meeting-notes", "meeting-notes")
        .map(|dirs| dirs.data_dir().to_path_buf())
}
```

Update every existing call site of `base_dir()` across `src-tauri/src/commands/*.rs` to pass the resolved config's `data_dir` as `Option<&Path>` (via `resolve_config().data_dir.map(PathBuf::from).as_deref()`) instead of calling it bare — this touches every command that currently calls `base_dir()`, which per earlier plans is most of them (`storage_commands.rs`, `summary_commands.rs`, `transcription_commands.rs`, and now this plan's own `data_dir_commands.rs`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p meeting-notes-storage base_dir -- --nocapture`
Expected: PASS

- [ ] **Step 6: Add commands for checking existing meetings and migrating**

```rust
// src-tauri/src/commands/data_dir_commands.rs
use meeting_notes_core::config::resolve_config;
use meeting_notes_storage::{base_dir, load_index};
use std::path::PathBuf;

#[tauri::command]
pub fn get_current_data_dir() -> Result<String, String> {
    let config = resolve_config();
    let dir = base_dir(config.data_dir.as_ref().map(PathBuf::from).as_deref())
        .ok_or("could not resolve data directory")?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn count_meetings_at(path: String) -> Result<usize, String> {
    let dir = PathBuf::from(path);
    if !dir.exists() {
        return Ok(0);
    }
    load_index(&dir).map(|index| index.len()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn migrate_meetings(from: String, to: String) -> Result<(), String> {
    let from_dir = PathBuf::from(&from).join("meetings");
    let to_dir = PathBuf::from(&to).join("meetings");
    std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;

    if from_dir.exists() {
        for entry in std::fs::read_dir(&from_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let dest = to_dir.join(entry.file_name());
            std::fs::rename(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }

    // Merge index.json entries (by id, keep-first) rather than overwriting —
    // the target location may already have its own meetings if the user is
    // switching back to a previously-used folder.
    let from_index = load_index(&PathBuf::from(&from)).unwrap_or_default();
    let mut to_index = load_index(&PathBuf::from(&to)).unwrap_or_default();
    for meeting in from_index {
        if !to_index.iter().any(|m| m.id == meeting.id) {
            to_index.push(meeting);
        }
    }
    std::fs::write(
        PathBuf::from(&to).join("index.json"),
        serde_json::to_string_pretty(&to_index).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
```

Register all three in `main.rs`'s `generate_handler![]`.

- [ ] **Step 7: Commit**

```bash
git add crates/meeting-notes-core/src/config.rs crates/meeting-notes-storage/src src-tauri/src/commands/data_dir_commands.rs src-tauri/src/main.rs
git commit -m "feat: add configurable data_dir override, base_dir() respects it, add migration command"
```

---

### Task 2: Gear icon in TitleBar, ConfigDialog becomes reopenable

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/components/ConfigDialog.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add a gear icon to TitleBar without disturbing the existing drag-fallback fix or the existing close button**

> **Correction, confirmed against a real screenshot:** the real `TitleBar.tsx` already renders a close (X) button on the right side, alongside the centered drag-dots — this wasn't visible in any project-knowledge fragment found earlier, so the original version of this step below was wrong (it placed the gear where the close button already lives, and omitted the close button entirely). The layout below places the gear on the **left**, mirroring the existing close button on the **right**, with the dots staying centered between them. **This is still reconstructed, not confirmed against the actual file** — verify against the real `TitleBar.tsx` (ideally by pasting/sharing it directly) before applying, since the exact close-button implementation (its click handler, whether it calls `getCurrentWindow().hide()` vs. something else, its exact icon/sizing) is still unknown here.

```tsx
// src/components/TitleBar.tsx (additions — preserve the existing
// onMouseDown/startDragging() WebKitGTK fix AND the existing close button
// exactly as-is; only add the gear button as a new sibling on the opposite
// side. The close button's own implementation below is a placeholder
// matching its position/appearance in the screenshot — replace with
// whatever the real close handler actually does.)
import { Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TitleBarProps {
  onOpenSettings: () => void;
  onClose: () => void; // existing prop/handler — verify actual name against real file
}

export function TitleBar({ onOpenSettings, onClose }: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      onMouseDown={/* existing startDragging() fallback handler, unchanged */}
      className="h-8 flex items-center justify-between gap-1 select-none bg-muted/50 px-2"
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation(); // don't let this click bubble into the drag handler
          onOpenSettings();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-6 w-6 text-muted-foreground hover:text-foreground"
        aria-label="Settings"
      >
        <Settings className="h-3.5 w-3.5" />
      </Button>

      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 rounded-full bg-muted-foreground/40" />
        ))}
      </div>

      {/* Existing close button — preserve its real implementation as-is,
          this is only a placeholder matching the screenshot's appearance */}
      <Button
        variant="ghost"
        size="icon"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-6 w-6 text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
```

Note: `variant="ghost"` + `size="icon"` is shadcn's real Button, sized down from its default `h-9 w-9` icon size to `h-6 w-6` via className — the exact same pattern already used for the Recording pill's stop button in an earlier plan. `onClick`/`onMouseDown` pass through normally since `Button` forwards refs and spreads props onto a native `<button>` underneath; the `stopPropagation()` calls work identically whether the element is `Button` or a raw `<button>`.

`e.stopPropagation()` on both `onClick` and `onMouseDown` is what keeps the gear button independently clickable without triggering a window drag — same principle already established for the Recording pill's stop button in an earlier plan.

- [ ] **Step 2: Let ConfigDialog be reopened after first-launch, not just shown once**

```tsx
// src/components/ConfigDialog.tsx (modify — real component is an inline
// panel via `if (!open) return null`, keep that architecture; just ensure
// `open`/`onSkip` work identically whether triggered by first-launch
// detection or by the gear icon)
```

The real component's existing `open`/`onSave`/`onSkip` props already support this — first-launch calls it with `open={showConfigDialog}` where `showConfigDialog` comes from `configNeedsSetup()`; this step just means `onOpenSettings` (wired in Step 3) sets that same boolean to `true` regardless of whether setup was already completed. No structural change to `ConfigDialog.tsx` itself should be needed here — verify this against the real file before assuming a rewrite is necessary.

- [ ] **Step 3: Wire the gear icon in App.tsx**

```tsx
// src/App.tsx (modify — add alongside the existing showConfigDialog state
// and configNeedsSetup() effect, don't replace them)
<TitleBar onOpenSettings={() => setShowConfigDialog(true)} />
```

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`. After completing first-launch setup (dialog no longer auto-shows), click the gear icon.
Expected: the same Settings panel reopens with previously-saved values pre-filled (not blank) — confirming this is genuinely "edit existing config," not just "re-run first-launch setup from scratch." Confirm dragging the title bar by its dot area still works (the WebKitGTK fallback fix must survive this change), and confirm the existing close (X) button on the right still works exactly as it did before this plan touched the file.

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx src/components/ConfigDialog.tsx src/App.tsx
git commit -m "feat: add gear icon to reopen settings panel after first launch"
```

---

### Task 3: Storage Location field with native folder picker and warn-and-choose migration

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/components/ConfigDialog.tsx`
- Create: `src/lib/dataDir.ts`

- [ ] **Step 1: Add the dialog plugin for native folder selection**

```bash
cd src-tauri && cargo add tauri-plugin-dialog
```

```bash
bun add @tauri-apps/plugin-dialog
```

Register in `main.rs`: `.plugin(tauri_plugin_dialog::init())`, add `"dialog:allow-open"` to `capabilities/default.json`.

- [ ] **Step 2: Add the TypeScript wrapper**

```ts
// src/lib/dataDir.ts
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export const getCurrentDataDir = () => invoke<string>("get_current_data_dir");
export const countMeetingsAt = (path: string) => invoke<number>("count_meetings_at", { path });
export const migrateMeetings = (from: string, to: string) =>
  invoke<void>("migrate_meetings", { from, to });

export const pickFolder = () => open({ directory: true, multiple: false });
```

- [ ] **Step 3: Add the Storage Location section with inline warn-and-choose flow**

```tsx
// src/components/ConfigDialog.tsx (additions — new section within the
// existing inline-panel structure, same styling conventions as the other
// fields; not a separate modal, consistent with this component's
// documented architecture)
import { getCurrentDataDir, countMeetingsAt, migrateMeetings, pickFolder } from "@/lib/dataDir";

const [currentDataDir, setCurrentDataDir] = useState("");
const [pendingNewDir, setPendingNewDir] = useState<string | null>(null);
const [existingMeetingCount, setExistingMeetingCount] = useState(0);

useEffect(() => {
  if (open) getCurrentDataDir().then(setCurrentDataDir);
}, [open]);

const handleChangeLocation = async () => {
  const selected = await pickFolder();
  if (!selected || typeof selected !== "string") return;
  const count = await countMeetingsAt(currentDataDir);
  if (count > 0) {
    setPendingNewDir(selected);
    setExistingMeetingCount(count);
  } else {
    // Nothing to migrate — just adopt the new location on save.
    setPendingNewDir(selected);
  }
};

const resolvePendingMove = async (shouldMove: boolean) => {
  if (!pendingNewDir) return;
  if (shouldMove) {
    await migrateMeetings(currentDataDir, pendingNewDir);
  }
  setCurrentDataDir(pendingNewDir);
  setPendingNewDir(null);
  // data_dir itself is persisted as part of the normal handleSave() flow
  // alongside the other fields — no separate save action here.
};
```

```tsx
{/* Storage Location field, alongside the existing Claude/Ollama/Whisper fields */}
<div>
  <label className="text-xs font-medium text-muted-foreground">Storage Location</label>
  <div className="flex items-center gap-2 mt-1">
    <span className="text-xs text-foreground truncate flex-1">{currentDataDir}</span>
    <Button variant="outline" size="sm" onClick={handleChangeLocation}>Change…</Button>
  </div>
</div>

{pendingNewDir && existingMeetingCount > 0 && (
  <div className="border border-amber-300 bg-amber-50 rounded-md p-3 text-xs space-y-2">
    <p className="text-amber-900">
      {existingMeetingCount} existing meeting{existingMeetingCount === 1 ? "" : "s"} found at the
      current location. What should happen to them?
    </p>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" onClick={() => resolvePendingMove(true)}>Move them</Button>
      <Button size="sm" variant="ghost" onClick={() => resolvePendingMove(false)}>Leave them, use new location only</Button>
      <Button size="sm" variant="ghost" onClick={() => setPendingNewDir(null)}>Cancel</Button>
    </div>
  </div>
)}
```

Update `handleSave` to include `data_dir: pendingNewDir ?? currentDataDir` in the saved config object, alongside the existing real fields (`claude_api_key`, `ollama_endpoint`, `ollama_model`, `ollama_num_ctx`, `summary_provider`, `whisper_model`).

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev` with at least one existing meeting recorded. Open Settings via the gear icon, click "Change…" on Storage Location, pick a different folder.
Expected: the amber warning box appears showing the correct existing-meeting count. Test "Move them" — confirm meeting files actually relocate and the app reads from the new location afterward (e.g. the moved meeting still opens correctly). Separately test "Leave them" — confirm the app starts fresh at the new location while the old meeting files remain untouched on disk at the old path.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs src-tauri/capabilities src/components/ConfigDialog.tsx src/lib/dataDir.ts
git commit -m "feat: add configurable storage location with native folder picker and migration warning"
```
