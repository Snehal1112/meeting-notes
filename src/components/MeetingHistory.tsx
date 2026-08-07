import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
} from "@/components/ui/pagination";
import { toast } from "sonner";
import { MeetingHistoryRow } from "@/components/MeetingHistoryRow";
import { openSummary, type MeetingMeta } from "@/lib/storage";
import { summarizeMeeting } from "@/lib/summary";
import { deleteMeeting, getMeetingHistory, revealInFileManager, type MeetingHistoryEntry } from "@/lib/history";
import { ChevronLeft, History as HistoryIcon } from "lucide-react";

interface MeetingHistoryProps {
  onBack: () => void;
  // Reuses RecorderWidget's existing resumeMeeting hand-off (App.tsx passes
  // this straight through to setResumeMeeting): retrying a Failed meeting
  // re-enters the exact same "skip straight to processing" path already
  // used for resuming an interrupted recording. Optional so tests that
  // don't exercise Retry can omit it.
  onRetryMeeting?: (meeting: MeetingMeta) => void;
  // Notifies the parent whenever content that changes this panel's natural
  // height changes (pagination, search/filter results, a row refreshed
  // after re-run/delete) -- see App.tsx's `historyContentVersion`, which
  // feeds useAutoResizeWindow's remeasureKey. Without this, the window
  // never re-measures once History is already open: this panel's own
  // wrapper div is flex-stretched to fill whatever height the window is
  // already pinned to, so its box size never changes even though its
  // content does, and ResizeObserver has nothing to react to.
  onContentChange?: () => void;
}

const PAGE_SIZE = 5;
const UNDO_WINDOW_MS = 6000;

export function MeetingHistory({ onBack, onRetryMeeting, onContentChange }: MeetingHistoryProps) {
  const [entries, setEntries] = useState<MeetingHistoryEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  const loadHistory = () =>
    getMeetingHistory()
      .then(setEntries)
      .catch((err) => console.error("Could not load meeting history:", err));

  useEffect(() => {
    loadHistory();
  }, []);

  // Every piece of state that can change this panel's rendered height:
  // the loaded entries themselves (initial load, delete, a re-run's
  // refreshed snippet), which page is showing, and the search/filter
  // criteria that change how many rows match.
  useEffect(() => {
    onContentChange?.();
  }, [entries, page, search, typeFilter, statusFilter, onContentChange]);

  const handleReveal = async (entry: MeetingHistoryEntry) => {
    try {
      await revealInFileManager(entry.id);
    } catch (err) {
      toast.error(`Could not open "${entry.title || "Untitled meeting"}" in file manager: ${err}`);
    }
  };

  const handleRerun = async (entry: MeetingHistoryEntry) => {
    try {
      await summarizeMeeting(entry.id);
      toast.success(`Summary regenerated for "${entry.title || "Untitled meeting"}"`);
      loadHistory(); // Refresh to pick up the new snippet.
    } catch (err) {
      toast.error(`Failed to regenerate summary: ${err}`);
    }
  };

  // Optimistic UI: the row disappears immediately and the actual
  // deleteMeeting call is deferred behind an undo toast's window. If the
  // app quits during that window the meeting simply reappears in history on
  // next launch -- a deliberate simplicity tradeoff (see the design spec),
  // not a bug.
  const handleDelete = (entry: MeetingHistoryEntry) => {
    setEntries((prev) => (prev ? prev.filter((e) => e.id !== entry.id) : prev));

    let undone = false;
    const timeoutId = setTimeout(() => {
      if (!undone) {
        deleteMeeting(entry.id).catch((err) => {
          console.error("Failed to delete meeting:", err);
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
          setEntries((prev) => (prev ? [...prev, entry] : prev));
        },
      },
      duration: UNDO_WINDOW_MS,
    });
  };

  const filtered = (entries ?? [])
    .filter((e) => {
      const matchesSearch = e.title.toLowerCase().includes(search.toLowerCase());
      const matchesType = typeFilter === "all" || e.meeting_type === typeFilter;
      const matchesStatus = statusFilter === "all" || e.status === statusFilter;
      return matchesSearch && matchesType && matchesStatus;
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped rather than driven by an effect: filtering can shrink the result
  // set below the current page's start on the very same render that changes
  // search/typeFilter/statusFilter, and an effect-based reset would show a
  // blank page for one frame before catching up.
  const currentPage = Math.min(page, totalPages);
  const pageEntries = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const updateFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };

  if (entries === null) {
    return <div className="text-xs text-muted-foreground p-4">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-2.5 h-full">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-xs" aria-label="Back" onClick={onBack}>
          <ChevronLeft />
        </Button>
        <span className="text-sm font-semibold text-foreground">Meeting History</span>
      </div>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-9 text-muted-foreground">
          <HistoryIcon className="h-7 w-7 opacity-40" />
          <span className="text-xs">No meetings yet</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Input
            placeholder="Search meetings…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="text-xs h-8"
          />
          <div className="flex gap-1.5">
            <Select value={typeFilter} onValueChange={updateFilter(setTypeFilter)}>
              <SelectTrigger aria-label="Type" className="h-7 text-[10px] w-auto gap-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Type: All</SelectItem>
                <SelectItem value="Standup">Standup</SelectItem>
                <SelectItem value="Retrospective">Retrospective</SelectItem>
                <SelectItem value="FeatureRequest">Feature Request</SelectItem>
                <SelectItem value="Incident">Incident</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={updateFilter(setStatusFilter)}>
              <SelectTrigger aria-label="Status" className="h-7 text-[10px] w-auto gap-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Status: All</SelectItem>
                <SelectItem value="Done">Done</SelectItem>
                <SelectItem value="Failed">Failed</SelectItem>
              </SelectContent>
            </Select>
            {/* Date filter deferred -- three Select triggers already fill the
                available width at 400px; see the design spec's Explicitly
                Cut section. */}
          </div>

          <div>
            {pageEntries.map((entry, i) => (
              <div key={entry.id}>
                <MeetingHistoryRow
                  entry={entry}
                  onOpen={() => openSummary(entry.id)}
                  onReveal={() => handleReveal(entry)}
                  onRerun={() => handleRerun(entry)}
                  onRetry={() => onRetryMeeting?.(entry)}
                  onDelete={() => handleDelete(entry)}
                />
                {i < pageEntries.length - 1 && <Separator />}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <Pagination>
              <PaginationContent className="gap-3">
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className={currentPage === 1 ? "pointer-events-none opacity-40" : "cursor-pointer"}
                  />
                </PaginationItem>
                <span className="text-[10px] text-muted-foreground px-1">
                  Page {currentPage} of {totalPages}
                </span>
                <PaginationItem>
                  <PaginationNext
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className={
                      currentPage === totalPages ? "pointer-events-none opacity-40" : "cursor-pointer"
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      )}
    </div>
  );
}
