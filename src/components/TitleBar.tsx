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
      className="h-8 flex items-center px-3 text-xs text-muted-foreground select-none border-b"
    >
      Meeting Notes
    </div>
  );
}
