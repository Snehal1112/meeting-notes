import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

// Radix Select drives its trigger through Pointer Events and scrolls the
// active item into view — APIs jsdom does not implement. This test exists to
// prove the stubs in test-setup.ts are enough to open the listbox and pick an
// item, so a failure here means the harness broke rather than a feature.
function Harness({ onChange }: { onChange: (value: string) => void }) {
  return (
    <Select defaultValue="a" onValueChange={onChange}>
      <SelectTrigger aria-label="Example">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Alpha</SelectItem>
        <SelectItem value="b">Beta</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("shadcn Select under jsdom", () => {
  it("shows the current value on the trigger", () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getByLabelText("Example")).toHaveTextContent("Alpha");
  });

  it("opens on click and reports the item the user picks", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByLabelText("Example"));
    await user.click(await screen.findByRole("option", { name: "Beta" }));

    expect(onChange).toHaveBeenCalledWith("b");
  });
});
