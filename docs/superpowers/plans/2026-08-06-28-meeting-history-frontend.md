# Meeting History — Frontend Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plan 27 (backend commands: `get_meeting_history`, `delete_meeting`, `reveal_in_file_manager`), plan 25 (the gear-icon-in-TitleBar precedent this reuses), and plan 24 (`openPath`, the removed Done state this feature is compensating for). This plan targets the real codebase structure — treat code samples as illustrative of intent per the same caveat used in plans 24/25.

**Goal:** A History icon in the title bar (next to Settings) opens a list view showing every past meeting — search, filter by type/status/date, paginated 5-per-page, each row showing title/date/duration/type/status/summary snippet, with a "⋯" menu for Reveal-in-file-manager/Re-run-summarization/Delete. Failed meetings get a prominent Retry action instead of a snippet. Delete removes the row immediately with an undo toast rather than a confirm step. Window grows taller (up to 600px) to show it, staying at Idle's existing ~400px width.

> **Deviation (2026-08-07):** Implemented as planned with these corrections:
> - `TitleBarProps` has no `onClose` (close is already handled internally);
>   only `onOpenHistory` was added. `MeetingHistory` got its own Back button
>   in its header, since the plan never wired a close affordance anywhere.
> - `useAutoResizeWindow` had no max-height override, only a monitor-fraction
>   cap — added an optional `maxHeightOverride` param (used only for
>   History's 600px cap) rather than hand-clamping in `App.tsx`.
> - `failure_reason` doesn't exist — plan 27 shipped `error_message`
>   flattened directly onto `MeetingHistoryEntry`'s `meta`, not a separate
>   field. All row/filter code reads `entry.error_message`.
> - Row click uses the existing `openSummary(id)` wrapper (index-validated
>   path, matches `RecorderWidget`'s own usage) instead of raw
>   `dataDir`-based path concatenation — no `dataDir` state needed at all.
> - `summarizeMeeting` takes a meeting id, not a whole entry; Re-run calls
>   `summarizeMeeting(entry.id)`.
> - **Retry's hand-off (flagged in the design spec as the most
>   under-specified part of this feature) is `App.tsx`'s existing
>   `resumeMeeting` state** — the same mechanism `ResumePrompt`'s
>   `handleResume` already uses to hand an interrupted recording to
>   `RecorderWidget`. `MeetingHistory` takes an optional `onRetryMeeting`
>   prop; `App.tsx` implements it as `setResumeMeeting` + closing History.
>   No second processing hand-off was built.
> - No `next-themes` in this repo (dark mode is a static, never-toggled CSS
>   class) — used `sonner`'s own `<Toaster/>` directly instead of the
>   shadcn wrapper, which requires that dependency.
> - Task 3's file list (`src-tauri/Cargo.toml`, `src-tauri/src/main.rs`) was
>   wrong — no Rust changes were needed; all three backend commands already
>   shipped in plan 27, and this repo registers commands in `lib.rs`, not
>   `main.rs`, anyway.
>
> Manual verification (each task's own Step 5, plus a live click-through of
> Retry/Re-run/Delete-undo) is still owed — no `bun run tauri dev` pass has
> occurred in this environment.

---

### Task 1: History icon, view shell, empty state

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Create: `src/components/MeetingHistory.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/history.ts` (new file)

- [ ] **Step 1: Add the History icon to TitleBar, alongside the gear icon from plan 25**

```tsx
// src/components/TitleBar.tsx (additions — this sits alongside plan 25's
// Settings gear button, both on the left side per that plan's layout;
// verify actual spacing/order against the real file once plan 25 has run)
import { History } from "lucide-react";

interface TitleBarProps {
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  onClose: () => void;
}

// inside the left-side button group, alongside the Settings button:
<Button
  variant="ghost"
  size="icon"
  onClick={(e) => { e.stopPropagation(); onOpenHistory(); }}
  onMouseDown={(e) => e.stopPropagation()}
  className="h-6 w-6 text-muted-foreground hover:text-foreground"
  aria-label="Meeting History"
>
  <History className="h-3.5 w-3.5" />
</Button>
```

- [ ] **Step 2: Add the TypeScript types and get_meeting_history wrapper**

```ts
// src/lib/history.ts
import { invoke } from "@tauri-apps/api/core";
import type { MeetingMeta } from "@/lib/storage";

export interface MeetingHistoryEntry extends MeetingMeta {
  snippet: string | null;
  failure_reason: string | null;
}

export const getMeetingHistory = () => invoke<MeetingHistoryEntry[]>("get_meeting_history");
export const deleteMeeting = (meetingId: string) => invoke<void>("delete_meeting", { meetingId });
export const revealInFileManager = (meetingId: string) =>
  invoke<void>("reveal_in_file_manager", { meetingId });
```

- [ ] **Step 3: Build the view shell with empty state**

```tsx
// src/components/MeetingHistory.tsx
import { useEffect, useState } from "react";
import { getMeetingHistory, type MeetingHistoryEntry } from "@/lib/history";
import { History as HistoryIcon } from "lucide-react";

interface MeetingHistoryProps {
  onBack: () => void;
}

export function MeetingHistory({ onBack }: MeetingHistoryProps) {
  const [entries, setEntries] = useState<MeetingHistoryEntry[] | null>(null);

  useEffect(() => {
    getMeetingHistory().then(setEntries);
  }, []);

  if (entries === null) {
    return <div className="text-xs text-muted-foreground p-4">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-2.5 h-full">
      <div className="text-sm font-semibold text-foreground">Meeting History</div>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-9 text-muted-foreground">
          <HistoryIcon className="h-7 w-7 opacity-40" />
          <span className="text-xs">No meetings yet</span>
        </div>
      ) : (
        <div>{/* rows, search, filters, pagination — Task 2 */}</div>
      )}
    </div>
  );
}
```

Note: search/filter bar is intentionally absent from the empty-state branch entirely (not just hidden), per the earlier mockup rationale — showing filter controls against zero results is clutter, not useful.

- [ ] **Step 4: Wire the icon into App.tsx with window resize, capping height at 600px**

```tsx
// src/App.tsx (additions — extends the real useAutoResizeWindow pattern
// already used for Idle's content-driven sizing per plan 20's deviation
// notes; verify the actual hook's API before assuming this integration
// point, this is illustrative)
const [showHistory, setShowHistory] = useState(false);

// Reuse Idle's existing ~400px width; only height grows, capped at 600px —
// pass this constraint into whatever the real useAutoResizeWindow hook
// exposes for max-height, or clamp manually if it doesn't support that
// directly.

<TitleBar
  onOpenSettings={() => setShowConfigDialog(true)}
  onOpenHistory={() => setShowHistory(true)}
/>

{showHistory ? (
  <MeetingHistory onBack={() => setShowHistory(false)} />
) : (
  <RecorderWidget onStateChange={setWidgetState} />
)}
```

- [ ] **Step 5: Manual verification**

Run: `bun run tauri dev`, click the History icon with zero meetings recorded.
Expected: window grows slightly taller, shows "No meetings yet" with no search/filter bar visible, icon in title bar is highlighted/active while History is open.

- [ ] **Step 6: Commit**

```bash
git add src/components/TitleBar.tsx src/components/MeetingHistory.tsx src/App.tsx src/lib/history.ts
git commit -m "feat: add History icon and view shell with empty state"
```

---

### Task 2: Rows, search/filter, pagination (shadcn Pagination, 5/page)

**Files:**
- Modify: `src/components/MeetingHistory.tsx`
- Create: `src/components/MeetingHistoryRow.tsx`

- [ ] **Step 1: Add search + filter state, all client-side per plan 27's scale decision**

```tsx
// src/components/MeetingHistory.tsx (additions)
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Pagination, PaginationContent, PaginationItem, PaginationPrevious, PaginationNext,
} from "@/components/ui/pagination";

const PAGE_SIZE = 5;

const [search, setSearch] = useState("");
const [typeFilter, setTypeFilter] = useState<string>("all");
const [statusFilter, setStatusFilter] = useState<string>("all");
const [page, setPage] = useState(1);

const filtered = (entries ?? []).filter((e) => {
  const matchesSearch = e.title.toLowerCase().includes(search.toLowerCase());
  const matchesType = typeFilter === "all" || e.meeting_type === typeFilter;
  const matchesStatus = statusFilter === "all" || e.status === statusFilter;
  return matchesSearch && matchesType && matchesStatus;
});

const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
const pageEntries = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

// Reset to page 1 whenever the filters change so you can't get stuck on an
// out-of-range page after narrowing results.
useEffect(() => setPage(1), [search, typeFilter, statusFilter]);
```

- [ ] **Step 2: Render search + filter bar (only when there's at least one entry)**

```tsx
<Input
  placeholder="Search meetings…"
  value={search}
  onChange={(e) => setSearch(e.target.value)}
  className="text-xs h-8"
/>
<div className="flex gap-1.5">
  <Select value={typeFilter} onValueChange={setTypeFilter}>
    <SelectTrigger className="h-7 text-[10px] w-auto gap-1"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="all">Type: All</SelectItem>
      <SelectItem value="Standup">Standup</SelectItem>
      <SelectItem value="Retrospective">Retrospective</SelectItem>
      <SelectItem value="FeatureRequest">Feature Request</SelectItem>
      <SelectItem value="Incident">Incident</SelectItem>
    </SelectContent>
  </Select>
  <Select value={statusFilter} onValueChange={setStatusFilter}>
    <SelectTrigger className="h-7 text-[10px] w-auto gap-1"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="all">Status: All</SelectItem>
      <SelectItem value="Done">Done</SelectItem>
      <SelectItem value="Failed">Failed</SelectItem>
    </SelectContent>
  </Select>
  {/* Date filter deferred to a fast-follow if needed — three Select
      triggers already fills the available width at 400px; a fourth
      (date) would need to replace one of these or move to a second row.
      Flagging rather than silently dropping it from the original spec. */}
</div>
```

- [ ] **Step 3: Build MeetingHistoryRow with the actions dropdown**

```tsx
// src/components/MeetingHistoryRow.tsx
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical, FolderOpen, RotateCw, Trash2 } from "lucide-react";
import type { MeetingHistoryEntry } from "@/lib/history";

interface MeetingHistoryRowProps {
  entry: MeetingHistoryEntry;
  onOpen: () => void;
  onReveal: () => void;
  onRerun: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

export function MeetingHistoryRow({ entry, onOpen, onReveal, onRerun, onRetry, onDelete }: MeetingHistoryRowProps) {
  const isFailed = entry.status === "Failed";

  return (
    <div className="py-2 relative">
      <div className="flex items-center justify-between gap-1.5 pr-5">
        <span onClick={onOpen} className="text-xs font-medium text-foreground cursor-pointer truncate">
          {entry.title || "Untitled meeting"}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Badge variant="outline" className="text-[8.5px] px-1.5 py-0">{entry.meeting_type}</Badge>
          <Badge variant={isFailed ? "destructive" : "secondary"} className="text-[8.5px] px-1.5 py-0">
            {entry.status}
          </Badge>
        </div>
      </div>
      <div className="text-[9.5px] text-muted-foreground mt-0.5">
        {/* date/duration formatting omitted here — reuse whatever
            date-formatting utility the real codebase already has, don't
            introduce a new one */}
      </div>

      {isFailed ? (
        <>
          <div className="text-[9.5px] text-destructive mt-0.5">{entry.failure_reason}</div>
          <Button size="sm" variant="default" onClick={onRetry} className="h-6 text-[9.5px] gap-1 mt-1.5 px-2.5">
            <RotateCw className="h-2.5 w-2.5" /> Retry
          </Button>
        </>
      ) : (
        entry.snippet && (
          <div className="text-[9.5px] text-muted-foreground mt-0.5 truncate">{entry.snippet}</div>
        )
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-5 w-5 absolute right-0 top-2 text-muted-foreground">
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onReveal}>
            <FolderOpen className="h-3 w-3 mr-1.5" /> Reveal in file manager
          </DropdownMenuItem>
          {!isFailed && (
            <DropdownMenuItem onClick={onRerun}>
              <RotateCw className="h-3 w-3 mr-1.5" /> Re-run summarization
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
            <Trash2 className="h-3 w-3 mr-1.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 4: Wire rows + pagination controls into MeetingHistory**

```tsx
// src/components/MeetingHistory.tsx (additions)
{pageEntries.map((entry, i) => (
  <div key={entry.id}>
    <MeetingHistoryRow
      entry={entry}
      onOpen={() => openPath(`${dataDir}/meetings/${entry.id}/summary.md`)}
      onReveal={() => revealInFileManager(entry.id)}
      onRerun={() => {/* Task 3 */}}
      onRetry={() => {/* Task 3 */}}
      onDelete={() => {/* Task 3 */}}
    />
    {i < pageEntries.length - 1 && <Separator />}
  </div>
))}

{totalPages > 1 && (
  <Pagination>
    <PaginationContent className="gap-3">
      <PaginationItem>
        <PaginationPrevious
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          className={page === 1 ? "pointer-events-none opacity-40" : "cursor-pointer"}
        />
      </PaginationItem>
      <span className="text-[10px] text-muted-foreground px-1">Page {page} of {totalPages}</span>
      <PaginationItem>
        <PaginationNext
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          className={page === totalPages ? "pointer-events-none opacity-40" : "cursor-pointer"}
        />
      </PaginationItem>
    </PaginationContent>
  </Pagination>
)}
```

- [ ] **Step 5: Manual verification**

Run: `bun run tauri dev` with 7+ recorded meetings (mix of Done and Failed statuses).
Expected: 5 rows per page, Previous disabled on page 1, Next disabled on the last page, search narrows results and resets to page 1, both filters work and combine with search (AND logic), Failed rows show the Retry button and failure reason instead of a snippet.

- [ ] **Step 6: Commit**

```bash
git add src/components/MeetingHistory.tsx src/components/MeetingHistoryRow.tsx
git commit -m "feat: add search, filters, and paginated rows to meeting history"
```

---

### Task 3: Delete-with-undo-toast, Retry, Re-run summarization

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/App.tsx`
- Modify: `src/components/MeetingHistory.tsx`

- [ ] **Step 1: Add sonner (shadcn's current toast component, replacing the deprecated Toast/Toaster pair)**

```bash
bun add sonner
```

```tsx
// src/App.tsx (mount once, near the root — verify shadcn's actual
// `sonner.tsx` wrapper component if `npx shadcn add sonner` was run,
// rather than importing raw `sonner` directly, if that file exists)
import { Toaster } from "@/components/ui/sonner";

// in the render tree, once:
<Toaster position="bottom-center" />
```

- [ ] **Step 2: Implement delete-immediately-with-deferred-actual-deletion**

```tsx
// src/components/MeetingHistory.tsx (additions)
import { toast } from "sonner";
import { deleteMeeting } from "@/lib/history";

const UNDO_WINDOW_MS = 6000;

const handleDelete = (entry: MeetingHistoryEntry) => {
  // Optimistic UI: remove immediately from the visible list.
  setEntries((prev) => (prev ? prev.filter((e) => e.id !== entry.id) : prev));

  let undone = false;
  const timeoutId = setTimeout(() => {
    if (!undone) {
      deleteMeeting(entry.id).catch((err) => {
        console.error("Failed to delete meeting:", err);
        // The row is already gone from the UI at this point — a failed
        // backend delete here is a real inconsistency (row hidden, file
        // still on disk) worth surfacing, not silently swallowing.
        toast.error(`Failed to delete "${entry.title}" — it may still exist on disk.`);
      });
    }
  }, UNDO_WINDOW_MS);

  toast(`"${entry.title || "Untitled meeting"}" deleted`, {
    action: {
      label: "Undo",
      onClick: () => {
        undone = true;
        clearTimeout(timeoutId);
        setEntries((prev) => (prev ? [...prev, entry] : prev)); // re-insert; exact sort position isn't critical for a few-second window
      },
    },
    duration: UNDO_WINDOW_MS,
  });
};
```

Note the documented tradeoff from the design discussion: if the app quits during the 6-second undo window, the `setTimeout` never fires, `deleteMeeting` is never called, and the meeting simply reappears in history on next launch — a deliberate simplicity tradeoff, not a bug, since persisting pending-delete state across a restart adds real complexity for a rare edge case.

- [ ] **Step 3: Wire Retry (failed meetings) and Re-run summarization (done meetings)**

```tsx
// src/components/MeetingHistory.tsx (additions)
import { transcribeMeeting } from "@/lib/transcription"; // reuse plan 08/12's existing function
import { summarizeMeeting } from "@/lib/summary"; // reuse plan 09/19's existing function

const handleRetry = async (entry: MeetingHistoryEntry) => {
  // Retry re-enters the same processing flow a live recording uses, rather
  // than building a separate in-history progress UI — closes History and
  // hands off to the existing Processing pill infrastructure.
  onBack();
  // The exact mechanism for "tell RecorderWidget to resume processing this
  // specific meeting" depends on how plan 12's resume-orphaned-recording
  // flow already signals RecorderWidget from outside — reuse that same
  // path rather than inventing a second one; this is a real integration
  // point that needs verifying against the actual resume flow's API.
};

const handleRerun = async (entry: MeetingHistoryEntry) => {
  try {
    await summarizeMeeting(entry);
    toast.success(`Summary regenerated for "${entry.title}"`);
    getMeetingHistory().then(setEntries); // refresh to pick up the new snippet
  } catch (err) {
    toast.error(`Failed to regenerate summary: ${err}`);
  }
};
```

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`. Delete a meeting, confirm it disappears immediately and a toast with Undo appears; click Undo before it expires and confirm the row returns; delete another and let the toast expire, confirm the meeting directory is actually gone from disk afterward. Separately, click Retry on a Failed meeting and confirm it hands off correctly into the existing Processing UI rather than doing nothing or erroring. Click Re-run summarization on a Done meeting and confirm the snippet updates afterward.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs src/App.tsx src/components/MeetingHistory.tsx
git commit -m "feat: add delete-with-undo-toast, retry, and re-run summarization to meeting history"
```
