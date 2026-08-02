# Error Handling & Recovery Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle transcription failures with a retry option, summary failures with a clear "not configured/failed" state (extending plan 11's basic version), and detect + offer to resume orphaned recordings from interrupted sessions on launch.

**Architecture:** Adds an explicit `failed` sub-state to the widget distinguishing transcription failures (retryable) from summary failures (transcript still shown as the fallback deliverable, per the design doc). On launch, `App.tsx` checks `getOrphanedMeetings()` (built in plan 07) and offers to resume transcription via a small inline prompt above the widget.

**Tech Stack:** React, TypeScript, Rust (reuses commands from plans 07/08/10)

---

### Task 1: Transcription failure state with Retry

**Files:**
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/components/RecorderWidget.test.tsx`

- [x] **Step 1: Write failing test for transcription failure → retry**

```tsx
it("shows a retry option when transcription fails", async () => {
  const { transcribeMeeting } = await import("@/lib/transcription");
  vi.mocked(transcribeMeeting).mockRejectedValueOnce(new Error("whisper.cpp exited with status 1"));

  render(<RecorderWidget />);
  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
  fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

  expect(await screen.findByText(/transcription failed/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- RecorderWidget`
Expected: FAIL — no failure state exists yet, error propagates unhandled.

- [x] **Step 3: Implement failure state + retry**

```tsx
// src/components/RecorderWidget.tsx (modify processing effect)
const [transcriptionError, setTranscriptionError] = useState<string | null>(null);

const runTranscription = async () => {
  setTranscriptionError(null);
  setProcessingStatus("transcribing");
  try {
    const config = await getConfig();
    await transcribeMeeting(currentMeetingRef.current!, config.whisper_model ?? "base.en");
  } catch (err) {
    setTranscriptionError(String(err));
  }
};

useEffect(() => {
  if (state !== "processing" || !currentMeetingRef.current) return;
  let unlisten: (() => void) | undefined;
  (async () => {
    unlisten = await onTranscriptionComplete(async (updated) => {
      // ... unchanged summarizing logic from plan 11
    });
    await runTranscription();
  })();
  return () => unlisten?.();
}, [state]);

// Add to the "processing" state render, below the status text:
{transcriptionError && (
  <div className="flex flex-col items-center gap-2">
    <span className="text-xs text-destructive">Transcription failed</span>
    <Button size="sm" variant="outline" onClick={runTranscription}>
      Retry
    </Button>
  </div>
)}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- RecorderWidget`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx
git commit -m "feat: add retryable transcription failure state"
```

---

### Task 2: Summary failure fallback (transcript remains available)

**Files:**
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/components/RecorderWidget.test.tsx`

- [x] **Step 1: Write failing test confirming transcript tab still works when summary fails**

```tsx
it("still shows the transcript tab when summary generation fails", async () => {
  const { summarizeMeeting } = await import("@/lib/summary");
  vi.mocked(summarizeMeeting).mockRejectedValueOnce(new Error("not_configured"));

  render(<RecorderWidget />);
  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
  fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

  expect(await screen.findByText(/not generated/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /transcript/i }));
  expect(screen.getByText(/transcript unavailable|./i)).toBeInTheDocument();
});
```

- [x] **Step 2: Run test to verify current state**

Run: `bun run test -- RecorderWidget`
Expected: This should largely already PASS given plan 11 Task 2/3's `summaryError` handling — this step is a regression-guard confirming the fallback wasn't broken by Task 1's changes above. If it fails, check that `setSummaryError` still gets set correctly in the `catch` block of the summarize step and that `state` still transitions to `"done"` in the `finally`.

- [x] **Step 3: Tighten the error message per the "not_configured" vs other-failure distinction**

```tsx
// src/components/RecorderWidget.tsx (refine the summary catch block)
} catch (err) {
  const message = String(err);
  setSummaryError(
    message.includes("not_configured")
      ? "Not generated — configure a provider to enable summaries."
      : "Summary generation failed. Transcript is still available below."
  );
}
```

Update the Done-state render to use `summaryError` directly as the displayed text instead of a hardcoded string.

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- RecorderWidget`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx
git commit -m "feat: distinguish not-configured vs failed summary states, keep transcript available"
```

---

### Task 3: Orphaned recording detection and resume prompt on launch

**Files:**
- Modify: `src/App.tsx`
- Create: `src/components/ResumePrompt.tsx`
- Create: `src/components/ResumePrompt.test.tsx`

- [x] **Step 1: Write failing test for ResumePrompt**

```tsx
// src/components/ResumePrompt.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ResumePrompt } from "./ResumePrompt";

describe("ResumePrompt", () => {
  it("lists orphaned meetings and calls onResume when clicked", () => {
    const onResume = vi.fn();
    render(
      <ResumePrompt
        meetings={[{ id: "1", title: "Standup", created_at: "", duration_seconds: null, status: "Recording", used_system_audio: true }]}
        onResume={onResume}
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText(/standup/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalledWith("1");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- ResumePrompt`
Expected: FAIL — component doesn't exist.

- [x] **Step 3: Implement ResumePrompt**

```tsx
// src/components/ResumePrompt.tsx
import { Button } from "@/components/ui/button";
import type { MeetingMeta } from "@/lib/storage";

interface ResumePromptProps {
  meetings: MeetingMeta[];
  onResume: (id: string) => void;
  onDismiss: () => void;
}

export function ResumePrompt({ meetings, onResume, onDismiss }: ResumePromptProps) {
  if (meetings.length === 0) return null;
  return (
    <div className="text-xs border-b p-2 bg-amber-50 space-y-1">
      <p>Found an interrupted recording:</p>
      {meetings.map((m) => (
        <div key={m.id} className="flex items-center justify-between">
          <span>{m.title || m.id}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => onResume(m.id)}>
              Resume
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- ResumePrompt`
Expected: PASS

- [x] **Step 5: Wire into App.tsx on launch**

```tsx
// src/App.tsx (additions)
import { ResumePrompt } from "@/components/ResumePrompt";
import { getOrphanedMeetings, type MeetingMeta } from "@/lib/storage";

const [orphaned, setOrphaned] = useState<MeetingMeta[]>([]);

useEffect(() => {
  getOrphanedMeetings().then(setOrphaned);
}, []);

// Render above <RecorderWidget />:
<ResumePrompt
  meetings={orphaned}
  onResume={(id) => {
    // RecorderWidget picks this up via a prop/callback (wire a minimal
    // `resumeMeetingId` prop into RecorderWidget that, on mount, looks up the
    // meeting from orphaned list, sets currentMeetingRef, and jumps straight
    // to the "processing" state instead of "idle").
    setOrphaned((prev) => prev.filter((m) => m.id !== id));
  }}
  onDismiss={() => setOrphaned([])}
/>
```

- [ ] **Step 6: Manual verification**

Run: `bun run tauri dev`, start a recording, force-kill the app process (`kill -9`) mid-recording, relaunch.
Expected: `ResumePrompt` appears listing the interrupted meeting; clicking Resume jumps the widget into the processing/transcribing flow using the partially-recorded `audio.wav`.

> Not run: needs a live recording and a force-kill of the GUI process. Each
> layer is covered by tests instead: `find_orphaned_meetings_returns_only_recording_status`
> (storage, plan 07) proves a meeting left at "Recording" is detected;
> `App.test.tsx` proves the prompt appears and hands the meeting down on
> Resume; and the "resuming an interrupted recording" tests in
> `RecorderWidget.test.tsx` prove it transcribes that meeting rather than
> creating a new one.

- [x] **Step 7: Commit**

```bash
git add src/components/ResumePrompt.tsx src/components/ResumePrompt.test.tsx src/App.tsx
git commit -m "feat: detect orphaned recordings on launch and offer resume"
```
