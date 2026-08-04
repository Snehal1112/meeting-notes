import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MeetingTypePicker } from "./MeetingTypePicker";

describe("MeetingTypePicker", () => {
  // Radix's SelectValue automatically echoes the selected SelectItem's own
  // children (icon + label, via ItemText) onto the trigger -- rendering the
  // icon a second time explicitly in the trigger duplicates it. The trigger
  // always carries its own chevron-down icon regardless (SelectTrigger's own
  // rendering, unrelated to this bug), so the correct total is 2: one
  // chevron plus exactly one copy of the meeting type's own icon.
  it("shows the selected type's icon exactly once on the trigger (plus the trigger's own chevron)", () => {
    render(<MeetingTypePicker value="Standup" onChange={vi.fn()} />);
    const trigger = screen.getByLabelText("Meeting type");
    expect(trigger.querySelectorAll("svg")).toHaveLength(2);
  });

  it("still shows the selected type's label on the trigger", () => {
    render(<MeetingTypePicker value="Standup" onChange={vi.fn()} />);
    expect(screen.getByLabelText("Meeting type")).toHaveTextContent("Standup");
  });
});
