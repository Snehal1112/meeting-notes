import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ActionItemsList } from "./ActionItemsList";

describe("ActionItemsList", () => {
  it("toggles item completion on checkbox click", () => {
    const onToggle = vi.fn();
    render(
      <ActionItemsList
        items={[{ id: "0", text: "Send follow-up email", completed: false }]}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("0");
  });

  it("renders one checkbox per item and reflects its completed state", () => {
    render(
      <ActionItemsList
        items={[
          { id: "0", text: "Send follow-up email", completed: true },
          { id: "1", text: "Book the room", completed: false },
        ]}
        onToggle={() => {}}
      />
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it("shows an empty-state message when there are no action items", () => {
    render(<ActionItemsList items={[]} onToggle={() => {}} />);
    expect(screen.getByText(/no action items/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
