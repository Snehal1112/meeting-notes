import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConfigDialog } from "./ConfigDialog";

describe("ConfigDialog", () => {
  it("calls onSave with entered values", () => {
    const onSave = vi.fn();
    render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
    fireEvent.change(screen.getByLabelText(/claude api key/i), {
      target: { value: "sk-abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ claude_api_key: "sk-abc" })
    );
  });

  it("calls onSkip when skip is clicked", () => {
    const onSkip = vi.fn();
    render(<ConfigDialog open onSave={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onSkip).toHaveBeenCalled();
  });
});
