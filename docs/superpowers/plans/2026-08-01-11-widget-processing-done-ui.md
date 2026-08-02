# Widget UI — Processing & Done States Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the widget's state machine with a proper Processing state (sequential "Transcribing…" → "Generating summary…" status) and a Done state showing summary, action items checklist, and transcript access.

**Architecture:** Extends `RecorderWidget` from plan 06/08 to call `summarizeMeeting` after `transcribeMeeting` resolves, tracking a finer-grained processing sub-status. The Done state renders `SummaryResult` inline with a shadcn `Tabs` for Summary/Action Items/Transcript, per the design's "secondary, not the widget's main focus" note for the transcript.

**Tech Stack:** React, TypeScript, shadcn/ui (`Tabs`, `Checkbox`, `Button`)

---

### Task 1: Sequential processing sub-status (Transcribing → Generating summary)

**Files:**
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/components/RecorderWidget.test.tsx`

- [x] **Step 1: Write failing test for sub-status text change**

```tsx
it("shows Transcribing then Generating summary during processing", async () => {
  const { onTranscriptionComplete } = await import("@/lib/transcription");
  const { summarizeMeeting } = await import("@/lib/summary");
  render(<RecorderWidget />);

  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
  fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

  expect(await screen.findByText(/transcribing/i)).toBeInTheDocument();
});
```

Ensure the existing mocks for `@/lib/transcription` and a new mock for `@/lib/summary` are set up at the top of the test file (`vi.mock("@/lib/summary", () => ({ summarizeMeeting: vi.fn().mockResolvedValue({ summary: "s", action_items: [] }) }))`), and that `onTranscriptionComplete`'s mock immediately invokes its callback with a `Summarizing`-status meeting to simulate the real event flow.

- [x] **Step 2: Run test to verify current behavior**

Run: `bun run test -- RecorderWidget`
Expected: PASS already for "Transcribing" text (built in plan 08) — this step confirms the baseline before adding the summary sub-status.

- [x] **Step 3: Implement processing sub-status state + summary trigger**

```tsx
// src/components/RecorderWidget.tsx (modify processing effect + render)
import { summarizeMeeting, type SummaryResult } from "@/lib/summary";

const [processingStatus, setProcessingStatus] = useState<"transcribing" | "summarizing">(
  "transcribing"
);
const [summaryResult, setSummaryResult] = useState<SummaryResult | null>(null);
const [summaryError, setSummaryError] = useState<string | null>(null);

useEffect(() => {
  if (state !== "processing" || !currentMeetingRef.current) return;

  let unlisten: (() => void) | undefined;
  (async () => {
    setProcessingStatus("transcribing");
    unlisten = await onTranscriptionComplete(async (updated) => {
      currentMeetingRef.current = updated;
      setProcessingStatus("summarizing");
      try {
        const result = await summarizeMeeting(updated);
        setSummaryResult(result);
      } catch (err) {
        setSummaryError(String(err));
      } finally {
        setState("done");
      }
    });
    const config = await getConfig();
    await transcribeMeeting(currentMeetingRef.current!, config.whisper_model ?? "base.en");
  })();

  return () => unlisten?.();
}, [state]);

// Replace the processing state render:
if (state === "processing") {
  return (
    <div className="flex flex-col gap-2 h-full justify-center items-center text-sm text-muted-foreground">
      <span>{processingStatus === "transcribing" ? "Transcribing…" : "Generating summary…"}</span>
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- RecorderWidget`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx
git commit -m "feat: add sequential processing sub-status and trigger summary generation"
```

---

### Task 2: Done state — summary + action items checklist

**Files:**
- Create: `src/components/ActionItemsList.tsx`
- Create: `src/components/ActionItemsList.test.tsx`
- Modify: `src/components/RecorderWidget.tsx`

- [x] **Step 1: Write failing test for ActionItemsList toggling**

```tsx
// src/components/ActionItemsList.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ActionItemsList } from "./ActionItemsList";

describe("ActionItemsList", () => {
  it("toggles item completion on checkbox click", () => {
    const onToggle = vi.fn();
    render(
      <ActionItemsList
        items={[{ id: "0", text: "Send follow-up email", completed: false }]}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("0");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- ActionItemsList`
Expected: FAIL — component doesn't exist.

- [x] **Step 3: Implement ActionItemsList**

```tsx
// src/components/ActionItemsList.tsx
import { Checkbox } from "@/components/ui/checkbox";

export interface ActionItem {
  id: string;
  text: string;
  completed: boolean;
}

interface ActionItemsListProps {
  items: ActionItem[];
  onToggle: (id: string) => void;
}

export function ActionItemsList({ items, onToggle }: ActionItemsListProps) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No action items found.</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2">
          <Checkbox
            checked={item.completed}
            onCheckedChange={() => onToggle(item.id)}
          />
          <span className={item.completed ? "line-through text-muted-foreground" : ""}>
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- ActionItemsList`
Expected: PASS

- [x] **Step 5: Wire ActionItemsList + summary into RecorderWidget's Done state**

```tsx
// src/components/RecorderWidget.tsx (replace done placeholder)
import { ActionItemsList, type ActionItem } from "@/components/ActionItemsList";

const [actionItems, setActionItems] = useState<ActionItem[]>([]);

useEffect(() => {
  if (summaryResult) {
    setActionItems(
      summaryResult.action_items.map((text, i) => ({ id: String(i), text, completed: false }))
    );
  }
}, [summaryResult]);

const toggleActionItem = (id: string) => {
  setActionItems((items) =>
    items.map((item) => (item.id === id ? { ...item, completed: !item.completed } : item))
  );
};

if (state === "done") {
  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto text-sm">
      {summaryError ? (
        <p className="text-xs text-muted-foreground">
          Not generated — configure a provider to enable summaries.
        </p>
      ) : (
        <>
          <p>{summaryResult?.summary}</p>
          <ActionItemsList items={actionItems} onToggle={toggleActionItem} />
        </>
      )}
      <div className="flex gap-2 mt-auto">
        <Button variant="outline" size="sm" onClick={() => setState("idle")}>
          New Recording
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Manual verification**

Run: `bun run tauri dev` with a provider configured, complete a full recording flow.
Expected: Done state shows summary text and a checklist of action items; checking an item strikes it through.

> Not run: needs a live mic recording and a configured provider. Covered at
> the component level by the "RecorderWidget done state" tests (summary text,
> one checkbox per action item, toggling a checkbox) and ActionItemsList.test.tsx.

- [x] **Step 7: Commit**

```bash
git add src/components/ActionItemsList.tsx src/components/ActionItemsList.test.tsx src/components/RecorderWidget.tsx
git commit -m "feat: add done state with summary and action items checklist"
```

---

### Task 3: Transcript tab + Save & Close action

**Files:**
- Modify: `src/components/RecorderWidget.tsx`

- [x] **Step 1: Add Tabs around the Done state content**

```tsx
// src/components/RecorderWidget.tsx (modify the "done" state block)
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const [transcriptText, setTranscriptText] = useState("");

// inside the summarizeMeeting success branch (Task 1's effect), after setSummaryResult:
// (fetch transcript text for display — add a tiny helper reading meeting_dir/transcript.txt
// via a new lightweight Tauri command `read_transcript_text(meeting)` mirroring the pattern
// in summary_commands.rs)

if (state === "done") {
  return (
    <div className="flex flex-col gap-2 h-full text-sm">
      <Tabs defaultValue="summary" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="grid grid-cols-3">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="actions">Action Items</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" className="overflow-y-auto flex-1">
          {summaryError ? (
            <p className="text-xs text-muted-foreground">
              Not generated — configure a provider to enable summaries.
            </p>
          ) : (
            <p>{summaryResult?.summary}</p>
          )}
        </TabsContent>
        <TabsContent value="actions" className="overflow-y-auto flex-1">
          <ActionItemsList items={actionItems} onToggle={toggleActionItem} />
        </TabsContent>
        <TabsContent value="transcript" className="overflow-y-auto flex-1 text-xs">
          {transcriptText || "Transcript unavailable."}
        </TabsContent>
      </Tabs>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setState("idle")}>
          New Recording
        </Button>
        <Button size="sm" onClick={() => setState("idle")}>
          Save &amp; Close
        </Button>
      </div>
    </div>
  );
}
```

Add the corresponding minimal Rust command `read_transcript_text` (in `transcription_commands.rs`) that reads `meeting_dir/transcript.txt` and returns it as a `String`, plus its `src/lib/transcription.ts` wrapper — follow the exact pattern already used for `transcribe_meeting`.

- [ ] **Step 2: Manual verification**

Run: `bun run tauri dev`, complete a recording flow, switch between Summary/Action Items/Transcript tabs.
Expected: all three tabs render correct content; "Save & Close" and "New Recording" both return the widget to idle state, ready for the next meeting.

> Not run: needs a live mic recording. Covered at the component level by the
> "RecorderWidget done state tabs" tests, which drive real tab switches with
> user-event and assert each tab's content plus both idle-returning buttons.

- [x] **Step 3: Commit**

```bash
git add src/components/RecorderWidget.tsx src-tauri/src/commands/transcription_commands.rs src-tauri/src/main.rs src/lib/transcription.ts
git commit -m "feat: add tabbed done state with transcript view and save/close actions"
```
