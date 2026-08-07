import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getMeetingHistory, type MeetingHistoryEntry } from "@/lib/history";
import { ChevronLeft, History as HistoryIcon } from "lucide-react";

interface MeetingHistoryProps {
  onBack: () => void;
}

export function MeetingHistory({ onBack }: MeetingHistoryProps) {
  const [entries, setEntries] = useState<MeetingHistoryEntry[] | null>(null);

  useEffect(() => {
    getMeetingHistory()
      .then(setEntries)
      .catch((err) => console.error("Could not load meeting history:", err));
  }, []);

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
        <div>{/* rows, search, filters, pagination -- Task 2 */}</div>
      )}
    </div>
  );
}
