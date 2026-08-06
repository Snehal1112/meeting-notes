# Skip Post-Recording Provider Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the post-recording "choosing provider" picker (Select +
"Generate Summary" button) from `RecorderWidget`'s Processing pill —
summarization should always start immediately once transcription finishes,
using the same provider resolution the Idle-page `ProviderPicker` already
shows as selected.

**Architecture:** Extract the provider-resolution logic (persisted
preference if available, else Ollama-preferring default, else the sole
configured provider) into one pure function, `resolveProvider`, in
`src/lib/summary.ts`. Both `ProviderPicker.tsx` (Idle screen highlight) and
`RecorderWidget.tsx` (post-recording auto-run) call it, so the two can never
disagree. `RecorderWidget`'s processing effect drops its
`available.length === 2` special case and always calls `runSummarization`
immediately.

**Tech Stack:** React + TypeScript, Vitest + Testing Library, Tauri.

## Global Constraints

- Comments end with a punctuation mark and use short, plain sentences (project convention, see `MY.md`).
- Code must build (`tsc --noEmit` and `vite build`) and pass the full Vitest suite before each commit.
- Do not run any `git commit` without the user's prior explicit go-ahead for that specific commit.

---

### Task 1: Add `resolveProvider` to `src/lib/summary.ts`

**Files:**
- Modify: `src/lib/summary.ts`
- Create: `src/lib/summary.test.ts`

**Interfaces:**
- Produces: `resolveProvider(config: AppConfig | null): ProviderKind | undefined` — exported from `src/lib/summary.ts`. Used by Task 2 (`ProviderPicker.tsx`) and Task 3 (`RecorderWidget.tsx`).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/summary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveProvider } from "./summary";
import type { AppConfig } from "@/lib/config";

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  claude_api_key: null,
  ollama_endpoint: null,
  ollama_model: null,
  ollama_num_ctx: null,
  summary_provider: null,
  whisper_model: null,
  ...overrides,
});

describe("resolveProvider", () => {
  it("returns undefined when config is null", () => {
    expect(resolveProvider(null)).toBeUndefined();
  });

  it("returns undefined when no provider is configured", () => {
    expect(resolveProvider(config())).toBeUndefined();
  });

  it("returns the sole configured provider when only Claude is set up", () => {
    expect(resolveProvider(config({ claude_api_key: "sk-test" }))).toBe("Claude");
  });

  it("returns the sole configured provider when only Ollama is set up", () => {
    expect(resolveProvider(config({ ollama_endpoint: "http://localhost:11434" }))).toBe("Ollama");
  });

  it("prefers Ollama when both are configured and no preference is persisted", () => {
    expect(
      resolveProvider(config({ claude_api_key: "sk-test", ollama_endpoint: "http://localhost:11434" }))
    ).toBe("Ollama");
  });

  it("returns the persisted preference when both are configured and it names an available provider", () => {
    expect(
      resolveProvider(
        config({
          claude_api_key: "sk-test",
          ollama_endpoint: "http://localhost:11434",
          summary_provider: "claude",
        })
      )
    ).toBe("Claude");
  });

  it("falls back to the Ollama-preferring default when the persisted preference names an unavailable provider", () => {
    expect(
      resolveProvider(
        config({
          ollama_endpoint: "http://localhost:11434",
          summary_provider: "claude",
        })
      )
    ).toBe("Ollama");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/summary.test.ts`
Expected: FAIL — `resolveProvider` is not exported from `src/lib/summary.ts`.

- [ ] **Step 3: Implement `resolveProvider`**

In `src/lib/summary.ts`, add the import and the function. The file currently starts with:

```ts
import { invoke } from "@tauri-apps/api/core";
```

Change it to:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/lib/config";
```

At the end of the file, after the existing `summarizeMeeting` export, add:

```ts

// Resolves which provider a summarization run should use: the user's
// persisted preference (set via the idle-state ProviderPicker) when it
// names a provider that's actually configured this run, falling back to
// the same Ollama-preferring order select_provider_kind uses on the Rust
// side (see crates/meeting-notes-summary/src/lib.rs) when there is no
// persisted preference or it names something unavailable. Returns
// undefined when nothing is configured, letting callers fall through to
// the backend's own "not_configured" error.
//
// Shared between ProviderPicker.tsx (what the Idle screen highlights) and
// RecorderWidget.tsx (what a run actually uses), so the two can never
// disagree about which provider is "selected".
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/summary.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

Ask the user for explicit go-ahead before running this (see Global Constraints).

```bash
git add src/lib/summary.ts src/lib/summary.test.ts
git commit -m "feat: add resolveProvider for shared provider resolution logic"
```

---

### Task 2: Use `resolveProvider` in `ProviderPicker`

**Files:**
- Modify: `src/components/ProviderPicker.tsx`
- Test: `src/components/ProviderPicker.test.tsx` (existing — no edits expected, run to confirm)

**Interfaces:**
- Consumes: `resolveProvider(config: AppConfig | null): ProviderKind | undefined` from Task 1.

- [ ] **Step 1: Replace the inline `selected` computation**

In `src/components/ProviderPicker.tsx`, the current body is:

```tsx
import { Button } from "@/components/ui/button";
import type { AppConfig } from "@/lib/config";

export type ProviderName = "ollama" | "claude";

interface ProviderPickerProps {
  config: AppConfig | null;
  onChange: (provider: ProviderName) => void;
}

// Lets the user trade privacy and cost against summary depth per meeting,
// rather than that trade-off being fixed by config precedence.
export function ProviderPicker({ config, onChange }: ProviderPickerProps) {
  if (!config) return null;

  const ollamaReady = Boolean(config.ollama_endpoint);
  const claudeReady = Boolean(config.claude_api_key);
  if (!ollamaReady && !claudeReady) return null;

  // Mirrors the backend's resolution: an explicit choice only counts when
  // that provider is configured, otherwise Ollama wins when available.
  const stored = config.summary_provider?.toLowerCase();
  const selected: ProviderName =
    stored === "claude" && claudeReady
      ? "claude"
      : stored === "ollama" && ollamaReady
        ? "ollama"
        : ollamaReady
          ? "ollama"
          : "claude";
```

Replace it with:

```tsx
import { Button } from "@/components/ui/button";
import type { AppConfig } from "@/lib/config";
import { resolveProvider } from "@/lib/summary";

export type ProviderName = "ollama" | "claude";

interface ProviderPickerProps {
  config: AppConfig | null;
  onChange: (provider: ProviderName) => void;
}

// Lets the user trade privacy and cost against summary depth per meeting,
// rather than that trade-off being fixed by config precedence.
export function ProviderPicker({ config, onChange }: ProviderPickerProps) {
  if (!config) return null;

  const ollamaReady = Boolean(config.ollama_endpoint);
  const claudeReady = Boolean(config.claude_api_key);
  if (!ollamaReady && !claudeReady) return null;

  // resolveProvider is shared with RecorderWidget's post-recording run, so
  // what's highlighted here always matches what a recording actually uses.
  // The guard above guarantees at least one provider is configured, so
  // resolveProvider cannot return undefined past this point.
  const selected = resolveProvider(config)!.toLowerCase() as ProviderName;
```

The rest of the component (the `options` array, the `unavailable` filter, and the returned JSX) is unchanged.

- [ ] **Step 2: Run the existing ProviderPicker tests**

Run: `npx vitest run src/components/ProviderPicker.test.tsx`
Expected: PASS (7 tests, unchanged) — this confirms the refactor is behavior-preserving.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

Ask the user for explicit go-ahead before running this (see Global Constraints).

```bash
git add src/components/ProviderPicker.tsx
git commit -m "refactor: use resolveProvider in ProviderPicker"
```

---

### Task 3: Remove the choosing-provider picker from `RecorderWidget`

**Files:**
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/components/RecorderWidget.test.tsx`

**Interfaces:**
- Consumes: `resolveProvider(config: AppConfig | null): ProviderKind | undefined` from Task 1.

- [ ] **Step 1: Drop the `Select` import**

In `src/components/RecorderWidget.tsx`, remove this line (it becomes unused once Step 4 removes the only JSX that references it):

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
```

Add `resolveProvider` to the existing summary import. Change:

```tsx
import { summarizeMeeting, toProviderKind, type ProviderKind } from "@/lib/summary";
```

to:

```tsx
import { summarizeMeeting, resolveProvider, type ProviderKind } from "@/lib/summary";
```

(`toProviderKind` is no longer called directly in this file once Step 3 removes the inline two-provider resolution — `resolveProvider` calls it internally instead.)

- [ ] **Step 2: Narrow `ProcessingStatus` and remove picker-only state**

Replace:

```tsx
export type WidgetState = "idle" | "recording" | "processing";
// "choosing_provider" is a distinct sub-status from "summarizing": it's the
// window between transcription finishing and the user confirming which
// provider to use for this run, shown only when more than one provider is
// configured. "summarizing" still means "the call is actually in flight".
type ProcessingStatus = "transcribing" | "choosing_provider" | "summarizing";
```

with:

```tsx
export type WidgetState = "idle" | "recording" | "processing";
type ProcessingStatus = "transcribing" | "summarizing";
```

Replace:

```tsx
  const [config, setConfig] = useState<AppConfig | null>(null);
  // Ephemeral, per-run provider choice for the summary about to be
  // generated — distinct from ProviderPicker/handleProviderChange above,
  // which set a persistent default saved to config. These are only
  // populated (and only shown) when transcription just finished with more
  // than one provider configured; they are not persisted anywhere.
  const [availableProviders, setAvailableProviders] = useState<ProviderKind[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind | null>(null);
  const currentMeetingRef = useRef<MeetingMeta | null>(null);
```

with:

```tsx
  const [config, setConfig] = useState<AppConfig | null>(null);
  const currentMeetingRef = useRef<MeetingMeta | null>(null);
```

- [ ] **Step 3: Call `runSummarization` immediately in the processing effect**

Replace:

```tsx
        const cfg = await getConfig().catch((err) => {
          console.error("Could not load config for provider selection:", errorMessage(err));
          return null;
        });
        if (cancelled) return;

        const available: ProviderKind[] = cfg
          ? [
              ...(cfg.claude_api_key ? (["Claude"] as const) : []),
              ...(cfg.ollama_endpoint ? (["Ollama"] as const) : []),
            ]
          : [];
        setAvailableProviders(available);

        if (available.length === 2) {
          // Both providers configured: don't auto-select — let the user
          // choose, and don't call summarizeMeeting until they confirm.
          // Because the call doesn't start until then, changing the
          // selection beforehand always changes which provider actually
          // runs; no cancellation of an in-flight call is needed.
          //
          // The default seeds from the user's persisted preference
          // (config.summary_provider, settable via the idle-state
          // ProviderPicker) when it names a provider that's actually
          // available this run, falling back to the same Ollama-preferring
          // order select_provider_kind uses on the Rust side (see
          // crates/meeting-notes-summary/src/lib.rs) when there is no
          // persisted preference or it names something unavailable. Picking
          // `available[0]` here would silently prefer Claude instead, since
          // `available` is always built Claude-first above — reversing the
          // backend's deliberate Ollama-first default and making a user's
          // explicit Ollama choice dead config the moment both are
          // configured.
          const persisted = toProviderKind(cfg?.summary_provider ?? null);
          const defaultProvider =
            persisted && available.includes(persisted)
              ? persisted
              : available.includes("Ollama")
                ? "Ollama"
                : available[0];
          setSelectedProvider(defaultProvider);
          setProcessingStatus("choosing_provider");
          return;
        }

        // 0 or 1 provider configured: unchanged from before — proceed
        // immediately with the single available provider (or with none at
        // all, letting the "not_configured" error path fire as usual).
        // available[0] is undefined in the zero-provider case; see
        // runSummarization for why that doesn't reach summarizeMeeting as an
        // explicit extra argument.
        await runSummarization(updated.id, available[0]);
```

with:

```tsx
        const cfg = await getConfig().catch((err) => {
          console.error("Could not load config for provider selection:", errorMessage(err));
          return null;
        });
        if (cancelled) return;

        // The provider was already effectively chosen on the Idle screen —
        // ProviderPicker shows the same resolution as selected before the
        // recording even started — so summarization starts immediately
        // rather than asking again here. undefined (nothing configured)
        // reaches summarizeMeeting as no explicit override, letting the
        // "not_configured" error path fire as usual.
        await runSummarization(updated.id, resolveProvider(cfg));
```

- [ ] **Step 4: Remove `handleConfirmProvider`**

Delete this block entirely:

```tsx
  // Fires only from the picker shown in the "choosing_provider" sub-status
  // (two providers configured) — this is the moment the deferred
  // summarize_meeting call actually starts, using whatever was selected.
  const handleConfirmProvider = () => {
    const meeting = currentMeetingRef.current;
    if (!meeting || !selectedProvider) return;
    void runSummarization(meeting.id, selectedProvider);
  };

```

(It sits directly between `handleProviderChange` and `handleStart`.)

- [ ] **Step 5: Update `runSummarization`'s comment**

It currently says:

```tsx
  // Actually calls summarize_meeting, opens the generated summary.md in the
  // system's default handler, and returns the widget to idle. Split out
  // from the processing effect below so it can be invoked either
  // immediately (0 or 1 provider configured — today's behavior, unchanged)
  // or later, from the picker's confirm button (2 providers configured), by
  // which point the effect that discovered `meetingId` has already returned.
```

Replace with:

```tsx
  // Actually calls summarize_meeting, opens the generated summary.md in the
  // system's default handler, and returns the widget to idle. Split out
  // from the processing effect below purely for readability.
```

- [ ] **Step 6: Remove the choosing-provider JSX branch**

In the `"processing"` render block, replace:

```tsx
        {transcriptionError ? (
          // The audio is always preserved on disk, so this is recoverable:
          // offer the retry rather than sending the user back to idle. The
          // underlying error sits alongside it so a missing binary or bad
          // model name is diagnosable, not just "it failed".
          <div role="alert" className="flex items-center gap-1.5 min-w-0">
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[10px] font-medium text-red-600">Transcription failed</span>
              <span className="text-[9px] text-muted-foreground truncate max-w-[130px]">
                {transcriptionError}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => runTranscription()}
              className="flex-shrink-0"
            >
              Retry
            </Button>
          </div>
        ) : processingStatus === "choosing_provider" ? (
          // Shown only when transcription just finished and more than one
          // provider is configured — see the processing effect above. The
          // summarize_meeting call is deliberately deferred until Generate
          // Summary is clicked, so switching the selection here always
          // changes which provider actually runs.
          <div className="flex items-center gap-1.5">
            <Select
              value={selectedProvider ?? undefined}
              onValueChange={(next) => setSelectedProvider(next as ProviderKind)}
            >
              {/* Height comes from the size prop, not a className:
                  SelectTrigger's own data-[size=*] rules outrank a plain
                  h-* utility, so an override there is silently dropped. */}
              <SelectTrigger
                size="sm"
                aria-label="Summary provider"
                className="text-xs w-[88px] flex-shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableProviders.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="xs"
              onClick={handleConfirmProvider}
              disabled={!selectedProvider}
              className="flex-shrink-0"
            >
              Generate Summary
            </Button>
          </div>
        ) : (
```

with:

```tsx
        {transcriptionError ? (
          // The audio is always preserved on disk, so this is recoverable:
          // offer the retry rather than sending the user back to idle. The
          // underlying error sits alongside it so a missing binary or bad
          // model name is diagnosable, not just "it failed".
          <div role="alert" className="flex items-center gap-1.5 min-w-0">
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[10px] font-medium text-red-600">Transcription failed</span>
              <span className="text-[9px] text-muted-foreground truncate max-w-[130px]">
                {transcriptionError}
              </span>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => runTranscription()}
              className="flex-shrink-0"
            >
              Retry
            </Button>
          </div>
        ) : (
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `ProviderKind` is now reported unused, check whether it's still referenced by `runSummarization`'s `provider?: ProviderKind` parameter — it is, so the import stays; this step is a safety check, not an expected failure.

- [ ] **Step 8: Update the picker-dependent tests**

In `src/components/RecorderWidget.test.tsx`, replace the entire `"RecorderWidget manual provider selection at summarize time"` describe block (it currently spans from its `describe(` line to the `});` immediately before `describe("RecorderWidget single provider configured"`):

```tsx
describe("RecorderWidget manual provider selection at summarize time", () => {
  // Distinct from "RecorderWidget provider picker" above: that one sets a
  // persistent default (summary_provider) via the idle-state ProviderPicker.
  // This describes the ephemeral, per-run choice offered once transcription
  // finishes with more than one provider configured.
  async function reachChoosingProvider() {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  beforeEach(async () => {
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
    });
  });

  it("shows a picker instead of summarizing immediately when two providers are configured", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    await reachChoosingProvider();

    expect(await screen.findByRole("button", { name: /generate summary/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/summary provider/i)).toBeInTheDocument();
    expect(summarizeMeeting).not.toHaveBeenCalled();
  });

  it("calls summarizeMeeting with the selected provider once Generate Summary is clicked", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const user = userEvent.setup();
    await reachChoosingProvider();

    // Switch away from the default (Ollama — see the Ollama-preferring
    // default test below) before confirming — this is what the deferred
    // call is for: the selection made before confirming is the one that
    // actually runs.
    await user.click(screen.getByLabelText(/summary provider/i));
    await user.click(await screen.findByRole("option", { name: "Claude" }));
    await user.click(screen.getByRole("button", { name: /generate summary/i }));

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Claude")
    );
  });

  it("opens the summary and returns to idle after confirming", async () => {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await reachChoosingProvider();
    await userEvent.click(screen.getByRole("button", { name: /generate summary/i }));

    await vi.waitFor(() =>
      expect(openPath).toHaveBeenCalledWith(
        `/home/user/.local/share/meeting-notes/meetings/${fakeMeeting.id}/summary.md`
      )
    );
    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });

  // Finding 2 of the whole-branch review: select_provider_kind on the Rust
  // side (crates/meeting-notes-summary/src/lib.rs) deliberately prefers
  // Ollama when both providers are configured and there's no persisted
  // preference. The picker's default must match, or a user who never set an
  // explicit preference gets Claude here while the rest of the app would
  // have picked Ollama for them.
  it("defaults the picker to Ollama when both providers are configured and no preference is persisted", async () => {
    await reachChoosingProvider();
    expect(await screen.findByLabelText(/summary provider/i)).toHaveTextContent("Ollama");
  });

  it("defaults the picker to the persisted provider preference when one is set", async () => {
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: "claude",
      whisper_model: "base.en",
    });
    await reachChoosingProvider();
    expect(await screen.findByLabelText(/summary provider/i)).toHaveTextContent("Claude");
  });
});
```

with:

```tsx
describe("RecorderWidget provider resolution at summarize time", () => {
  // Distinct from "RecorderWidget provider picker" above: that one sets a
  // persistent default (summary_provider) via the idle-state ProviderPicker.
  // This describes what actually runs once transcription finishes with more
  // than one provider configured — resolved the same way resolveProvider
  // resolves the Idle screen's highlighted choice, with no picker in between.
  async function completeTranscription() {
    const { onTranscriptionComplete } = await import("@/lib/transcription");
    let fire: ((meeting: MeetingMeta) => void) | undefined;
    vi.mocked(onTranscriptionComplete).mockImplementation(async (callback) => {
      fire = callback;
      return () => {};
    });

    render(<RecorderWidget />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await vi.waitFor(() => expect(fire).toBeDefined());
    await act(async () => {
      fire!({ ...fakeMeeting, status: "Summarizing" });
    });
  }

  it("summarizes immediately with Ollama when both providers are configured and no preference is persisted", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
    });

    await completeTranscription();

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Ollama")
    );
    expect(screen.queryByRole("button", { name: /generate summary/i })).not.toBeInTheDocument();
  });

  it("summarizes immediately with the persisted preference when one is set", async () => {
    const { summarizeMeeting } = await import("@/lib/summary");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: "claude",
      whisper_model: "base.en",
    });

    await completeTranscription();

    await vi.waitFor(() =>
      expect(summarizeMeeting).toHaveBeenCalledWith(fakeMeeting.id, "Claude")
    );
  });

  it("opens the summary and returns to idle without any picker interaction", async () => {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    const { getConfig } = await import("@/lib/config");
    vi.mocked(getConfig).mockResolvedValue({
      claude_api_key: "sk-test",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: "base.en",
    });

    await completeTranscription();

    await vi.waitFor(() =>
      expect(openPath).toHaveBeenCalledWith(
        `/home/user/.local/share/meeting-notes/meetings/${fakeMeeting.id}/summary.md`
      )
    );
    expect(await screen.findByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });
});
```

Leave the `"RecorderWidget single provider configured"` describe block immediately after this one unchanged — it already exercises `resolveProvider`'s single-provider path and needs no picker interaction.

- [ ] **Step 9: Run the full test suite**

Run: `npx vitest run --exclude '**/.claude/**' --exclude '**/node_modules/**'`
Expected: PASS, no failures. (The `.claude/**` exclude works around an unrelated nested-worktree/duplicate-React issue in this checkout — see prior session notes; it is not something this plan introduces or should fix.)

- [ ] **Step 10: Commit**

Ask the user for explicit go-ahead before running this (see Global Constraints).

```bash
git add src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx
git commit -m "feat: skip the post-recording provider picker, summarize immediately"
```

---

### Task 4: Shrink the Processing pill width back to 260px

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Update `PILL_SIZES.processing`**

The current code is:

```tsx
const PILL_SIZES: Record<"recording" | "processing", { width: number; height: number }> = {
  recording: { width: 224, height: 56 },
  // Wider than the Recording pill: unlike the Recording pill's timer (always
  // rendered font-mono regardless of the global body font), this pill's
  // "choosing_provider" sub-branch (Select trigger + "Generate Summary"
  // button) renders in the global body font. With that font reverted to
  // JetBrains Mono (wider per-character than the Inter it was sized
  // against), the old 260px budget was too tight once qualityWarning's icon
  // was also present -- widened for headroom.
  // Height is taller than the Recording pill's 56px: the "summarizing"
  // sub-status's explanatory sentence now wraps to 2 lines instead of being
  // truncated to 1 (see RecorderWidget.tsx), and needs the extra vertical
  // room to avoid trading a horizontal overflow bug for a vertical one.
  processing: { width: 300, height: 64 },
};
```

Replace it with:

```tsx
const PILL_SIZES: Record<"recording" | "processing", { width: number; height: number }> = {
  recording: { width: 224, height: 56 },
  // Wider than the Recording pill: this pill can hold a Retry button and
  // qualityWarning's icon, rendered in the global body font (JetBrains
  // Mono, wider per-character than the Inter it was previously sized
  // against).
  // Height is taller than the Recording pill's 56px: the "summarizing"
  // sub-status's explanatory sentence wraps to 2 lines instead of being
  // truncated to 1 (see RecorderWidget.tsx), and needs the extra vertical
  // room to avoid trading a horizontal overflow bug for a vertical one.
  processing: { width: 260, height: 64 },
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the App tests**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS (this file doesn't assert on pixel sizes, so it should be unaffected — this run just confirms nothing else broke).

- [ ] **Step 4: Commit**

Ask the user for explicit go-ahead before running this (see Global Constraints).

```bash
git add src/App.tsx
git commit -m "fix: shrink the Processing pill back to 260px now the provider picker is gone"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run --exclude '**/.claude/**' --exclude '**/node_modules/**'`
Expected: PASS, all tests green.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Full build**

Run: `npm run build` (or `bun run build` if `bun` is available — both run `tsc && vite build`)
Expected: builds successfully, no errors.

- [ ] **Step 4: Rust sanity check**

Run: `cd src-tauri && cargo check`
Expected: builds successfully. (No Rust files are touched by this plan; this just confirms nothing else in the tree regressed.)

- [ ] **Step 5: Report to the user**

Summarize what changed and note that live manual verification (`bun run tauri dev`, a real recording → transcription → summarization cycle with two providers configured) was not performed if no display/audio hardware is available in the environment — flag this as a follow-up for the user to do themselves before merging.
