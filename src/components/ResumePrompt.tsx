import { Button } from "@/components/ui/button";
import type { MeetingMeta } from "@/lib/storage";

interface ResumePromptProps {
  meetings: MeetingMeta[];
  onResume: (id: string) => void;
  onDismiss: (id: string) => void;
}

// Shown above the widget on launch when a previous session left a recording
// unfinished (the app crashed, slept, or was killed mid-recording). The
// partial audio.wav is still on disk, so the recording is worth transcribing.
export function ResumePrompt({ meetings, onResume, onDismiss }: ResumePromptProps) {
  if (meetings.length === 0) return null;
  return (
    <div className="text-xs border-b p-2 bg-amber-50 space-y-1">
      <p>Found an interrupted recording:</p>
      {meetings.map((m) => (
        <div key={m.id} className="flex items-center justify-between gap-2">
          {/* Untitled recordings store an empty title, so fall back to the
              id rather than rendering a blank row. */}
          <span className="truncate">{m.title || m.id}</span>
          <div className="flex gap-1 shrink-0">
            <Button size="sm" variant="outline" onClick={() => onResume(m.id)}>
              Resume
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDismiss(m.id)}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
