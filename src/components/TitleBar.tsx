import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      onMouseDown={(e) => {
        // WebKitGTK's native data-tauri-drag-region support is unreliable on Linux;
        // start the drag manually as a fallback.
        if (e.button === 0) {
          getCurrentWindow().startDragging();
        }
      }}
      className="h-8 flex items-center justify-center gap-1 select-none bg-muted/50"
    >
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 rounded-full bg-muted-foreground/40" />
      ))}
    </div>
  );
}
