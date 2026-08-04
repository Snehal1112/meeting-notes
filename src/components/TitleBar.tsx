import { startWindowDrag } from "@/lib/drag";

export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      // The grip dots are decorative, so a press on one still drags -- see
      // requireSelfTarget in startWindowDrag for why the pills differ.
      onMouseDown={(e) => startWindowDrag(e)}
      className="h-8 flex items-center justify-center gap-1 select-none bg-muted/50"
    >
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 rounded-full bg-muted-foreground/40" />
      ))}
    </div>
  );
}
