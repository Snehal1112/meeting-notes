# Manual LLM Provider Selection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on `SummaryProvider`/`SummaryResult`/`Config`/`build_provider` existing — originally written against plan 18, which was superseded by plan 13 before either shipped; plan 13 provides the same prerequisites in its own shape. Task 1's code samples below predate plan 13 (they reference `templates`, `MeetingMeta`-typed `summarize_meeting`, and a 2-arg `OllamaProvider::new`) — the actual implementation (commit `41db718`) instead threads `provider_override` through the real `summarize_meeting(app, meeting_id, provider_override)` signature and 3-arg `OllamaProvider::new`, matching plan 13.

**Goal:** Let the user choose Claude vs. Ollama before summarization starts (instead of it being silently auto-selected by config precedence), and let them regenerate the summary with the other provider from the Done state to compare output.

**Architecture:** `summarize_meeting` gains an optional `provider_override: Option<ProviderKind>` parameter — when present, `build_provider` is called with that explicit kind instead of running `select_provider_kind`'s auto-selection logic. The frontend shows a picker in the Processing state (populated with whichever providers are actually configured, per `getConfig()`) before triggering summarization, and a "Regenerate with [other provider]" button in the Done state that re-invokes `summarize_meeting` with the alternate provider and replaces the displayed result.

**Tech Stack:** Rust, React, TypeScript

---

### Task 1: provider_override parameter on summarize_meeting — DONE (commit `41db718`)

> Implemented directly against plan 13's shipped architecture rather than
> the code samples below (written against superseded plan 18). See
> `build_provider_for_kind` in `crates/meeting-notes-summary/src/lib.rs`
> and the `provider_override` parameter on `summarize_meeting` in
> `src-tauri/src/commands/summary_commands.rs`. Tests in
> `crates/meeting-notes-summary/src/selection_tests.rs`.

**Files:**
- Modify: `crates/meeting-notes-summary/src/lib.rs`
- Modify: `src-tauri/src/commands/summary_commands.rs`

- [x] **Step 1: Add a build_provider_for_kind function that skips auto-selection**

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

- [x] **Step 2: Thread an optional override through summarize_meeting**

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

Not yet done — deferred to Task 2/3's manual verification, which exercises
this same command through the real picker and regenerate UI rather than a
devtools console call.

Run: `bun run tauri dev` with both a Claude API key and an Ollama endpoint configured, call `invoke("summarize_meeting", { meeting, providerOverride: "Ollama" })` from devtools console on an already-transcribed meeting.
Expected: summary is generated using Ollama specifically, regardless of which provider `select_provider_kind` would have auto-picked.

- [x] **Step 4: Commit**

Committed as `41db718 feat: add explicit provider override to summarize_meeting (plan 19 task 1)`.

---

### Task 2: Provider picker in the Processing state, before summarization

**Files:**
- Modify: `src/lib/summary.ts`
- Modify: `src/components/RecorderWidget.tsx`

- [x] **Step 1: Update the TypeScript wrapper to accept an optional override — DONE (commit `41db718`)**

Implemented against the real signature (`summarizeMeeting(meetingId: string, ...)`, matching plan 13 — not the `meeting: MeetingMeta` sample below, which predates plan 13):

```ts
// src/lib/summary.ts (modify)
export type ProviderKind = "Claude" | "Ollama";

export const summarizeMeeting = (meeting: MeetingMeta, providerOverride?: ProviderKind) =>
  invoke<SummaryResult>("summarize_meeting", { meeting, providerOverride: providerOverride ?? null });
```

- [x] **Step 2: Determine available providers from config and show a picker — DONE (commit `95f8184`)**

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

> **Deviation from the sample above (commit `95f8184`):** the code sample fires `summarizeMeeting` immediately on entering "summarizing", which cannot satisfy this same section's Step 3 requirement that changing the picker before completion changes the provider used — an immediate, uncancellable call can't be redirected after the fact. Resolved by gating: with 0 or 1 configured providers, behavior is unchanged (immediate call, no picker); with exactly 2, the picker plus a "Generate Summary" confirm button are shown and `summarizeMeeting` is only invoked on confirm, using the shadcn `Select` from `src/components/ui/select.tsx` (precedent: `MeetingTypePicker.tsx`), not a raw `<select>`.

- [x] **Step 3: Manual verification — partially done (commit `95f8184`)**

`bun run tauri dev` was not run (no display/audio/Tauri runtime in the implementing environment). Verified instead: `bun run build` (tsc strict + vite) clean; full `vitest` suite 83/83 passing, including 3 new tests exercising the gated picker (picker shown + no auto-call with 2 providers, confirm sends the switched selection, confirm still reaches the done state) and all 52 pre-existing `RecorderWidget.test.tsx` tests (no regressions). A live `bun run tauri dev` pass with both providers configured is still outstanding — do this before relying on the picker in real use.

- [x] **Step 4: Commit — DONE (commit `95f8184`)**

```bash
git add src/lib/summary.ts src/components/RecorderWidget.tsx
git commit -m "feat: show provider picker before summarization when multiple providers configured"
```

---

### Task 3: "Regenerate with [other provider]" in the Done state

**Files:**
- Modify: `src/components/RecorderWidget.tsx`

- [x] **Step 1: Add a regenerate handler that calls summarizeMeeting with the alternate provider — DONE (commit `acfcaf7`)**

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

- [x] **Step 2: Render the regenerate button in the Done state, only when a second provider is actually available — DONE (commit `acfcaf7`)**

```tsx
// src/components/RecorderWidget.tsx (inside the "done" state render, near Save & Close / New Recording)
{otherProvider() && (
  <Button variant="ghost" size="sm" onClick={handleRegenerate} disabled={isRegenerating}>
    {isRegenerating ? "Regenerating…" : `Regenerate with ${otherProvider()}`}
  </Button>
)}
```

> **Deviation from the samples above (commit `acfcaf7`):** `summarizeMeeting(currentMeetingRef.current, target)` is wrong twice over — it passes the whole `MeetingMeta` instead of `.id`, and (more importantly) hand-rolling `setSummaryResult` without also updating `actionItems` would silently break the checklist on regenerate, contradicting Step 3's own "summary and action items update in place" expectation below. The actual `handleRegenerate` instead calls the `runSummarization(meetingId, provider?)` helper added in Task 2, which already does the summarize call, `setSummaryResult`, `setActionItems`, and error handling — no second copy of that logic exists. `setSelectedProvider(target)` runs unconditionally after the call (not only on success), so a failed regenerate still lets the user immediately retry the other provider. Also: `otherProvider()` needed an explicit `selectedProvider === null` guard — without it, the 1-provider-configured case (where `selectedProvider` is never set) would satisfy `p !== selectedProvider` and wrongly offer to "regenerate" into the same lone provider. Caught by a test before commit.

- [x] **Step 3: Manual verification — partially done (commit `acfcaf7`)**

`bun run tauri dev` was not run (no display/audio/Tauri runtime in the implementing environment). Verified instead: `bun run build` clean; full `vitest` suite 88/88 passing (6 new tests covering button visibility with 1 vs. 2 providers configured, the null-`selectedProvider` guard, regenerate updating both summary and action items, and label/target flipping after a successful regenerate). Not covered by tests: the `summary.md`/`action_items.json` on-disk overwrite behavior (spans the Rust backend, unchanged by this task) and the failure-path retry behavior. A live `bun run tauri dev` pass with both providers configured is still outstanding.

Run: `bun run tauri dev` with both providers configured, complete a recording, click "Regenerate with Ollama" (or Claude, whichever wasn't used first).
Expected: summary and action items update in place to the alternate provider's output; the button label flips to offer the other provider next; both `summary.md` and `action_items.json` on disk reflect the most recent regeneration (this overwrite behavior — no history of prior generations kept — matches the MVP's "no meeting list/history" scope; note this to the user if they later want generation history preserved).

- [x] **Step 4: Commit — DONE (commit `acfcaf7`)**

```bash
git add src/components/RecorderWidget.tsx
git commit -m "feat: add regenerate-with-other-provider action to done state"
```
