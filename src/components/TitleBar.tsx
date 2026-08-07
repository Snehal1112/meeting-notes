import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { startWindowDrag } from "@/lib/drag";
import { History, Settings, X } from "lucide-react";

interface TitleBarProps {
  onOpenSettings: () => void;
  onOpenHistory: () => void;
}

export function TitleBar({ onOpenSettings, onOpenHistory }: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      // The settings, history, and close buttons are real interactive
      // children now, so a press on any of them must not be swallowed into a
      // window drag -- see requireSelfTarget in startWindowDrag, same
      // reasoning as the Stop/Retry buttons inside the Recording/Processing
      // pills.
      onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
      className="h-8 grid grid-cols-[1fr_auto_1fr] items-center select-none bg-muted/50"
    >
      <div className="flex items-center gap-0.5 ml-1 justify-self-start">
        <Button variant="ghost" size="icon-xs" aria-label="Settings" onClick={onOpenSettings}>
          <Settings />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Meeting History" onClick={onOpenHistory}>
          <History />
        </Button>
      </div>
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1 w-1 rounded-full bg-muted-foreground/40" />
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close"
        className="mr-1 justify-self-end"
        onClick={() => {
          void getCurrentWindow()
            .close()
            .catch((err) => console.error("TitleBar: failed to close window", err));
        }}
      >
        <X />
      </Button>
    </div>
  );
}
