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
import { MeetingHistoryRow } from "@/components/MeetingHistoryRow";
import { openSummary } from "@/lib/storage";
import { getMeetingHistory, revealInFileManager, type MeetingHistoryEntry } from "@/lib/history";
import { ChevronLeft, History as HistoryIcon } from "lucide-react";

interface MeetingHistoryProps {
  onBack: () => void;
}

const PAGE_SIZE = 5;

export function MeetingHistory({ onBack }: MeetingHistoryProps) {
  const [entries, setEntries] = useState<MeetingHistoryEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    getMeetingHistory()
      .then(setEntries)
      .catch((err) => console.error("Could not load meeting history:", err));
  }, []);

  const filtered = (entries ?? []).filter((e) => {
    const matchesSearch = e.title.toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === "all" || e.meeting_type === typeFilter;
    const matchesStatus = statusFilter === "all" || e.status === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

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
                  onReveal={() => revealInFileManager(entry.id)}
                  onRerun={() => {
                    /* Task 3 */
                  }}
                  onRetry={() => {
                    /* Task 3 */
                  }}
                  onDelete={() => {
                    /* Task 3 */
                  }}
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
