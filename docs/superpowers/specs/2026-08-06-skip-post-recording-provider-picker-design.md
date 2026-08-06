# Skip Post-Recording Provider Picker Design

**Goal:** The Idle-page `ProviderPicker` already shows one summary provider as
selected (Ollama- or Claude-highlighted, resolved from persisted preference
or a sensible default) before the user ever clicks Start Recording. Once
recording stops and transcription finishes, if both providers are
configured, the widget currently shows a second picker (`choosing_provider`
processing sub-status: a `Select` + "Generate Summary" button) and waits for
an explicit confirmation before calling `summarize_meeting`. This is
redundant — the provider was effectively already chosen on the Idle screen.
This change removes that second picker entirely: summarization always starts
immediately once transcription completes, using the same resolution the
Idle screen already shows.

**Explicitly out of scope:** The Idle-page `ProviderPicker`'s own UI
(the segmented pill radio group) is unchanged — it still lets the user
explicitly persist a preference by clicking. Recording and Idle states'
layouts are otherwise untouched.

---

## Architecture / Components

Add one pure, exported function to `src/lib/summary.ts`:

```ts
export function resolveProvider(config: AppConfig | null): ProviderKind | undefined {
  if (!config) return undefined;
  const available: ProviderKind[] = [
    ...(config.claude_api_key ? (["Claude"] as const) : []),
    ...(config.ollama_endpoint ? (["Ollama"] as const) : []),
  ];
  if (available.length === 0) return undefined;
  const persisted = toProviderKind(config.summary_provider);
  return persisted && available.includes(persisted)
    ? persisted
    : available.includes("Ollama")
      ? "Ollama"
      : available[0];
}
```

This generalizes the two-provider resolution logic that already lives in
`RecorderWidget.tsx`'s processing effect to also cover the 0/1-provider
cases, which today reach the same answer through a separate code path
(`available[0]`).

`AppConfig` needs importing into `src/lib/summary.ts` for the parameter
type (currently only defined in `src/lib/config.ts`).

**`ProviderPicker.tsx`** calls `resolveProvider(config)` instead of its own
inline `selected` computation, converting the capitalized `ProviderKind`
result to the lowercase `ProviderName` it renders
(`resolveProvider(config)?.toLowerCase() as ProviderName`, guarded by the
existing `if (!ollamaReady && !claudeReady) return null` which guarantees a
defined result by the time this cast runs).

**`RecorderWidget.tsx`**'s processing effect drops the
`available.length === 2` branch entirely. Once transcription completes and
fresh config is fetched:

```ts
const provider = resolveProvider(cfg);
await runSummarization(updated.id, provider);
```

replaces the current `if (available.length === 2) { ...picker setup... }` /
fallthrough `await runSummarization(updated.id, available[0])` split.

This removes, as dead code:
- `availableProviders` / `selectedProvider` state
- the `"choosing_provider"` value from the `ProcessingStatus` union (now
  just `"transcribing" | "summarizing"`)
- `handleConfirmProvider`
- the `Select` / `SelectContent` / `SelectItem` / `SelectTrigger` /
  `SelectValue` JSX block and its import (unused elsewhere in this file)

**`App.tsx`**: `PILL_SIZES.processing` width reverts `300 → 260`. 300 was
specifically sized for the Select-trigger + "Generate Summary" button that
no longer renders; 260 was the prior, still-valid width accounting for the
`qualityWarning` icon and the JetBrains Mono body font. Height (64) is
unchanged — that's justified by the unrelated "summarizing" sub-status's
2-line wrap text, which this change doesn't touch.

## Data Flow

- **Idle:** `ProviderPicker` always shows one option highlighted via
  `resolveProvider(config)`. Clicking a pill still explicitly persists a
  choice via `handleProviderChange` → `setSummaryProvider` (unchanged).
- **Stop → Processing:** transcription completes → fresh config fetched →
  `resolveProvider(cfg)` computed once → `runSummarization` called
  immediately with that provider. No intermediate picker step, ever,
  regardless of how many providers are configured.

## Error Handling

Unchanged. `resolveProvider` returning `undefined` (nothing configured) is
exactly equivalent to today's `available[0]` being `undefined` in the
zero-provider case — same `"not_configured"` error path in
`runSummarization`, same log-and-return-to-idle behavior.

## Testing

- Remove the `"RecorderWidget manual provider selection at summarize time"`
  describe block in `RecorderWidget.test.tsx` (picker/confirm-button tests
  no longer apply — there is no picker to render or confirm).
- Add tests in its place asserting `summarizeMeeting` is called immediately
  (no click required) with `"Ollama"` when both providers are configured
  with no persisted preference, and with `"Claude"` when
  `summary_provider: "claude"` is persisted — covering the same two cases
  the removed block did, adapted to the no-picker flow.
- `"RecorderWidget single provider configured"` describe block should keep
  passing unchanged (single-provider resolution is unaffected).
- Add `src/lib/summary.test.ts` (new file — none exists yet) covering
  `resolveProvider`: no config, no providers configured, single provider
  configured, persisted-and-available preference, persisted-but-unavailable
  preference falling back to the Ollama-preferring order.
- `ProviderPicker.test.tsx`'s existing tests (selection/default/disabled
  states) already assert the resolved-selection behavior end-to-end via the
  rendered radio's checked state; they should keep passing unchanged and
  don't need new assertions.
