import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { startWindowDrag } from "@/lib/drag";
import { X } from "lucide-react";

export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      // The close button is a real interactive child now, so a press on it
      // must not be swallowed into a window drag -- see requireSelfTarget
      // in startWindowDrag, same reasoning as the Stop/Retry buttons inside
      // the Recording/Processing pills.
      onMouseDown={(e) => startWindowDrag(e, { requireSelfTarget: true })}
      className="h-8 grid grid-cols-[1fr_auto_1fr] items-center select-none bg-muted/50"
    >
      {/* Empty first column balances the close button's column below, so
          the grip dots stay centered on the whole bar regardless of the
          button's width -- a fixed-width spacer would need to track the
          button's size by hand instead. */}
      <span />
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
