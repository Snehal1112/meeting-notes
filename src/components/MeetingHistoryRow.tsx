import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical, FolderOpen, RotateCw, Trash2 } from "lucide-react";
import type { MeetingHistoryEntry } from "@/lib/history";

interface MeetingHistoryRowProps {
  entry: MeetingHistoryEntry;
  onOpen: () => void;
  onReveal: () => void;
  onRerun: () => void;
  rerunning?: boolean;
  onRetry: () => void;
  onDelete: () => void;
}

// No existing date/duration formatting utility in this codebase to reuse --
// kept local and minimal since nothing else needs it yet.
function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function MeetingHistoryRow({
  entry,
  onOpen,
  onReveal,
  onRerun,
  rerunning = false,
  onRetry,
  onDelete,
}: MeetingHistoryRowProps) {
  const isFailed = entry.status === "Failed";
  const duration = formatDuration(entry.duration_seconds);

  return (
    <div className="py-2 relative">
      <div className="flex items-center justify-between gap-1.5 pr-5">
        <span onClick={onOpen} className="text-xs font-medium text-foreground cursor-pointer truncate">
          {entry.title || "Untitled meeting"}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Badge variant="outline" className="text-[8.5px] px-1.5 py-0">
            {entry.meeting_type}
          </Badge>
          <Badge variant={isFailed ? "destructive" : "secondary"} className="text-[8.5px] px-1.5 py-0">
            {entry.status}
          </Badge>
        </div>
      </div>
      <div className="text-[9.5px] text-muted-foreground mt-0.5">
        {formatDate(entry.created_at)}
        {duration ? ` · ${duration}` : ""}
      </div>

      {isFailed ? (
        <>
          <div className="text-[9.5px] text-destructive mt-0.5">{entry.error_message}</div>
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
          <Button
            variant="ghost"
            size="icon"
            aria-label="Actions"
            className="h-5 w-5 absolute right-0 top-2 text-muted-foreground"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onReveal}>
            <FolderOpen className="h-3 w-3 mr-1.5" /> Reveal in file manager
          </DropdownMenuItem>
          {!isFailed && (
            <DropdownMenuItem onClick={onRerun} disabled={rerunning}>
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
