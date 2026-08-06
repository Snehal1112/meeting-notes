# TitleBar Close Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a close button to `src/components/TitleBar.tsx` that quits the
app, and grant the `core:window:allow-close` permission it needs — today
there is no way to close the app from the UI at all (`decorations: false`,
no tray, no shortcut, no in-app control).

**Architecture:** `getCurrentWindow().close()` from `@tauri-apps/api/window`
closes the single window, which (no `on_window_event`/`ExitRequested`
override exists in `src-tauri/src/lib.rs`) exits the whole process via
Tauri's default behavior. `core:window:allow-close` is not included in
`core:default`'s nested `core:window:default` set, so it must be added
explicitly to `src-tauri/capabilities/default.json`, or the call is
silently rejected by Tauri's IPC layer.

**Tech Stack:** React + TypeScript, Vitest + Testing Library, Tauri 2.

## Global Constraints

- Comments end with a punctuation mark and use short, plain sentences.
- Code must build (`tsc --noEmit`) and pass the full Vitest suite before commit.
- Ask the user for explicit go-ahead before any `git commit`.

---

### Task 1: Add the close permission and the TitleBar close button

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/components/TitleBar.tsx`
- Create: `src/components/TitleBar.test.tsx`

- [ ] **Step 1: Add the `core:window:allow-close` permission**

In `src-tauri/capabilities/default.json`, the current `permissions` array is:

```json
  "permissions": [
    "core:default",
    "opener:default",
    {
      "identifier": "opener:allow-open-path",
      "allow": [{ "path": "$HOME/.local/share/meeting-notes/**" }]
    },
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-current-monitor"
  ]
```

Add `"core:window:allow-close"` to it (plain string — window commands
aren't scoped by path like the opener plugin's `open_path`, no scope
object needed):

```json
  "permissions": [
    "core:default",
    "opener:default",
    {
      "identifier": "opener:allow-open-path",
      "allow": [{ "path": "$HOME/.local/share/meeting-notes/**" }]
    },
    "core:window:allow-start-dragging",
    "core:window:allow-set-size",
    "core:window:allow-current-monitor",
    "core:window:allow-close"
  ]
```

- [ ] **Step 2: Verify the capability change builds**

Run: `cd src-tauri && cargo check`
Expected: builds cleanly (Tauri's build script validates capability
entries against the plugin/core permission schema — an invalid identifier
would fail this step).

- [ ] **Step 3: Write the failing TitleBar tests**

Create `src/components/TitleBar.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TitleBar } from "./TitleBar";

const close = vi.fn(() => Promise.resolve());
const startDragging = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close, startDragging }),
}));

beforeEach(() => {
  close.mockClear();
  startDragging.mockClear();
});

describe("TitleBar", () => {
  it("closes the window when the close button is clicked", () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(close).toHaveBeenCalled();
  });

  it("does not start a window drag when the close button is pressed", () => {
    render(<TitleBar />);
    fireEvent.mouseDown(screen.getByRole("button", { name: /close/i }));
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("still starts a window drag when the background is pressed", () => {
    render(<TitleBar />);
    const dragRegion = document.querySelector("[data-tauri-drag-region]")!;
    fireEvent.mouseDown(dragRegion);
    expect(startDragging).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/components/TitleBar.test.tsx`
Expected: FAIL — `TitleBar` renders no element with role `button` yet
(no close button exists), and the mocked `close`/`startDragging` are never
called.

- [ ] **Step 5: Implement the close button**

The current `src/components/TitleBar.tsx` is:

```tsx
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
```

Replace it with:

```tsx
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/TitleBar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run --exclude '**/.claude/**' --exclude '**/node_modules/**'`
Expected: PASS, no failures (the `.claude/**` exclude works around an
unrelated nested-worktree/duplicate-React issue in this checkout — not
something this task introduces or should fix).

- [ ] **Step 9: Commit**

Ask the user for explicit go-ahead before running this.

```bash
git add src-tauri/capabilities/default.json src/components/TitleBar.tsx src/components/TitleBar.test.tsx
git commit -m "feat: add a close button to the TitleBar"
```

---

### Task 2: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Note the limitation**

No display or Tauri runtime is available in this implementing environment
(no `bun run tauri dev` possible here) — this task must be done by the
user, not skipped or claimed as done without it.

- [ ] **Step 2: Live check**

Run `bun run tauri dev`, reach the Idle state, and confirm:
- The close (X) button appears at the right edge of the title bar.
- The three grip dots are still visually centered in the bar.
- Clicking the close button quits the app (the process actually exits, not
  just hides the window).
- Dragging the title bar background (not the button) still moves the
  window as before.
