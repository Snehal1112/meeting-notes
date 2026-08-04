import { describe, it, expect, vi, beforeEach } from "vitest";
import { startWindowDrag } from "./drag";

const startDragging = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

// Stands in for a React MouseEvent: only the three fields startWindowDrag
// actually reads.
function mouseDown({
  button = 0,
  onSelf = true,
}: { button?: number; onSelf?: boolean } = {}) {
  const container = document.createElement("div");
  const child = document.createElement("button");
  container.appendChild(child);
  return { button, target: onSelf ? container : child, currentTarget: container };
}

beforeEach(() => {
  startDragging.mockClear();
});

describe("startWindowDrag", () => {
  it("starts a drag on a left press", () => {
    startWindowDrag(mouseDown());
    expect(startDragging).toHaveBeenCalled();
  });

  it("ignores non-left buttons", () => {
    startWindowDrag(mouseDown({ button: 2 }));
    expect(startDragging).not.toHaveBeenCalled();
  });

  // The Recording/Processing pills are the only drag surface in their states
  // and they hold real controls (Stop, Retry, the provider Select, Generate
  // Summary). A mousedown bubbling up from one of those must not be turned
  // into a window drag.
  it("ignores a press that bubbled up from a child when requireSelfTarget is set", () => {
    startWindowDrag(mouseDown({ onSelf: false }), { requireSelfTarget: true });
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("still drags when the press landed on the surface itself with requireSelfTarget set", () => {
    startWindowDrag(mouseDown({ onSelf: true }), { requireSelfTarget: true });
    expect(startDragging).toHaveBeenCalled();
  });

  // The TitleBar's grip dots are decorative, so pressing one -- dead centre
  // of the bar -- must still drag the window.
  it("drags from a child press when requireSelfTarget is not set", () => {
    startWindowDrag(mouseDown({ onSelf: false }));
    expect(startDragging).toHaveBeenCalled();
  });
});
