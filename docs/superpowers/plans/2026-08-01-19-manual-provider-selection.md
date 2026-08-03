# Manual LLM Provider Selection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plan 18 (structured SummaryResult) being complete.

**Goal:** Let the user choose Claude vs. Ollama before summarization starts (instead of it being silently auto-selected by config precedence), and let them regenerate the summary with the other provider from the Done state to compare output.

**Architecture:** `summarize_meeting` gains an optional `provider_override: Option<ProviderKind>` parameter — when present, `build_provider` is called with that explicit kind instead of running `select_provider_kind`'s auto-selection logic. The frontend shows a picker in the Processing state (populated with whichever providers are actually configured, per `getConfig()`) before triggering summarization, and a "Regenerate with [other provider]" button in the Done state that re-invokes `summarize_meeting` with the alternate provider and replaces the displayed result.

**Tech Stack:** Rust, React, TypeScript

---

### Task 1: provider_override parameter on summarize_meeting

**Files:**
- Modify: `crates/meeting-notes-summary/src/lib.rs`
- Modify: `src-tauri/src/commands/summary_commands.rs`

- [ ] **Step 1: Add a build_provider_for_kind function that skips auto-selection**

```rust
// crates/meeting-notes-summary/src/lib.rs (additions)
pub fn build_provider_for_kind(
    config: &Config,
    kind: ProviderKind,
) -> Option<Box<dyn SummaryProvider + Send + Sync>> {
    match kind {
        ProviderKind::Claude => config
            .claude_api_key
            .clone()
            .map(|key| Box::new(claude::ClaudeProvider::new(key)) as Box<dyn SummaryProvider + Send + Sync>),
        ProviderKind::Ollama => config
            .ollama_endpoint
            .clone()
            .map(|endpoint| Box::new(ollama::OllamaProvider::new(endpoint, None)) as Box<dyn SummaryProvider + Send + Sync>),
    }
}
```

Also derive `Serialize, Deserialize` on `ProviderKind` (currently just `Debug, PartialEq, Eq, Clone, Copy` from plan 10) so it can cross the Tauri IPC boundary as a command argument.

- [ ] **Step 2: Thread an optional override through summarize_meeting**

```rust
// src-tauri/src/commands/summary_commands.rs (modify signature and provider selection)
use meeting_notes_summary::{build_provider, build_provider_for_kind, templates, ProviderKind};

#[tauri::command]
pub async fn summarize_meeting(
    app: AppHandle,
    meeting: MeetingMeta,
    provider_override: Option<ProviderKind>,
) -> Result<SummaryResult, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meeting_dir = meeting.dir_path(&base);
    let transcript = std::fs::read_to_string(meeting_dir.join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))?;

    let config = resolve_config();
    let provider = match provider_override {
        Some(kind) => build_provider_for_kind(&config, kind)
            .ok_or_else(|| format!("{kind:?} is not configured"))?,
        None => build_provider(&config).ok_or("not_configured")?,
    };

    // ... rest unchanged from plan 18 (template selection, generate, write files, emit event)
}
```

- [ ] **Step 3: Manual verification via devtools**

Run: `bun run tauri dev` with both a Claude API key and an Ollama endpoint configured, call `invoke("summarize_meeting", { meeting, providerOverride: "Ollama" })` from devtools console on an already-transcribed meeting.
Expected: summary is generated using Ollama specifically, regardless of which provider `select_provider_kind` would have auto-picked.

- [ ] **Step 4: Commit**

```bash
git add crates/meeting-notes-summary/src src-tauri/src/commands/summary_commands.rs
git commit -m "feat: add explicit provider override to summarize_meeting"
```

---

### Task 2: Provider picker in the Processing state, before summarization

**Files:**
- Modify: `src/lib/summary.ts`
- Modify: `src/components/RecorderWidget.tsx`

- [ ] **Step 1: Update the TypeScript wrapper to accept an optional override**

```ts
// src/lib/summary.ts (modify)
export type ProviderKind = "Claude" | "Ollama";

export const summarizeMeeting = (meeting: MeetingMeta, providerOverride?: ProviderKind) =>
  invoke<SummaryResult>("summarize_meeting", { meeting, providerOverride: providerOverride ?? null });
```

- [ ] **Step 2: Determine available providers from config and show a picker**

```tsx
// src/components/RecorderWidget.tsx (additions)
import type { ProviderKind } from "@/lib/summary";

const [availableProviders, setAvailableProviders] = useState<ProviderKind[]>([]);
const [selectedProvider, setSelectedProvider] = useState<ProviderKind | null>(null);

// when entering "summarizing" sub-status (inside the existing processing effect),
// before calling summarizeMeeting:
const config = await getConfig();
const available: ProviderKind[] = [
  ...(config.claude_api_key ? (["Claude"] as const) : []),
  ...(config.ollama_endpoint ? (["Ollama"] as const) : []),
];
setAvailableProviders(available);
const defaultProvider = available[0] ?? null;
setSelectedProvider(defaultProvider);
```

The state and detection logic above (`availableProviders`, `selectedProvider`) is all this plan adds — the actual picker markup is a compact shadcn `Select` (not a raw `<select>`), built as part of plan 20's Processing-state pill redesign (which supersedes any earlier rendering of this picker). If plan 20 hasn't run yet, a temporary plain `<select>` bound to the same `selectedProvider`/`setSelectedProvider` state is a fine placeholder for manual testing in this plan — just don't treat it as the final UI.

Pass `selectedProvider ?? undefined` into `summarizeMeeting(meeting, ...)` — when only one (or zero) providers are configured, this behaves exactly as before (no picker shown, auto-selection or "not configured" state as already built in plan 10).

- [ ] **Step 3: Manual verification**

Run: `bun run tauri dev` with both providers configured, complete a recording, confirm the picker appears during "Generating summary…" and changing it before summarization completes uses the newly selected provider.

- [ ] **Step 4: Commit**

```bash
git add src/lib/summary.ts src/components/RecorderWidget.tsx
git commit -m "feat: show provider picker before summarization when multiple providers configured"
```

---

### Task 3: "Regenerate with [other provider]" in the Done state

**Files:**
- Modify: `src/components/RecorderWidget.tsx`

- [ ] **Step 1: Add a regenerate handler that calls summarizeMeeting with the alternate provider**

```tsx
// src/components/RecorderWidget.tsx (additions)
const [isRegenerating, setIsRegenerating] = useState(false);

const otherProvider = (): ProviderKind | null => {
  const other = availableProviders.find((p) => p !== selectedProvider);
  return other ?? null;
};

const handleRegenerate = async () => {
  const target = otherProvider();
  if (!target || !currentMeetingRef.current) return;
  setIsRegenerating(true);
  try {
    const result = await summarizeMeeting(currentMeetingRef.current, target);
    setSummaryResult(result);
    setSelectedProvider(target);
    setSummaryError(null);
  } catch (err) {
    setSummaryError(String(err));
  } finally {
    setIsRegenerating(false);
  }
};
```

- [ ] **Step 2: Render the regenerate button in the Done state, only when a second provider is actually available**

```tsx
// src/components/RecorderWidget.tsx (inside the "done" state render, near Save & Close / New Recording)
{otherProvider() && (
  <Button variant="ghost" size="sm" onClick={handleRegenerate} disabled={isRegenerating}>
    {isRegenerating ? "Regenerating…" : `Regenerate with ${otherProvider()}`}
  </Button>
)}
```

- [ ] **Step 3: Manual verification**

Run: `bun run tauri dev` with both providers configured, complete a recording, click "Regenerate with Ollama" (or Claude, whichever wasn't used first).
Expected: summary and action items update in place to the alternate provider's output; the button label flips to offer the other provider next; both `summary.md` and `action_items.json` on disk reflect the most recent regeneration (this overwrite behavior — no history of prior generations kept — matches the MVP's "no meeting list/history" scope; note this to the user if they later want generation history preserved).

- [ ] **Step 4: Commit**

```bash
git add src/components/RecorderWidget.tsx
git commit -m "feat: add regenerate-with-other-provider action to done state"
```
