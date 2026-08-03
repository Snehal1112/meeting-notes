import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

// Radix primitives that open a floating layer (Select, and any dropdown or
// popover added later) drive their trigger through Pointer Events and scroll
// the active item into view. jsdom implements none of these, so opening one
// throws "hasPointerCapture is not a function" before any assertion runs.
// Stubbing them is enough — nothing under test depends on real capture
// semantics or real scrolling. src/components/ui/select.test.tsx guards this.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});
