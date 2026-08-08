import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SummaryChecklist } from "@/components/SummaryChecklist";

describe("SummaryChecklist", () => {
  it("renders all three step labels", () => {
    render(<SummaryChecklist currentStep={null} chunkIndex={0} chunkTotal={1} />);
    expect(screen.getByText("Extracting topics & summary")).toBeInTheDocument();
    expect(screen.getByText("Finding action items")).toBeInTheDocument();
    expect(screen.getByText("Checking for open questions")).toBeInTheDocument();
  });

  it("shows every step as upcoming before the first progress event", () => {
    render(<SummaryChecklist currentStep={null} chunkIndex={0} chunkTotal={1} />);
    const topics = screen.getByText("Extracting topics & summary");
    expect(topics.className).not.toContain("line-through");
  });

  it("marks earlier steps complete and the current step active", () => {
    render(<SummaryChecklist currentStep="ActionItems" chunkIndex={0} chunkTotal={1} />);
    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
    expect(screen.getByText("Finding action items").className).not.toContain("line-through");
    expect(screen.getByText("Finding action items").className).not.toContain("text-muted-foreground");
    expect(screen.getByText("Checking for open questions").className).toContain("text-muted-foreground");
    expect(screen.getByText("Checking for open questions").className).not.toContain("line-through");
  });

  it("marks every step complete when currentStep is complete", () => {
    render(<SummaryChecklist currentStep="complete" chunkIndex={0} chunkTotal={1} />);
    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
    expect(screen.getByText("Finding action items").className).toContain("line-through");
    expect(screen.getByText("Checking for open questions").className).toContain("line-through");
  });

  it("marks the active step errored when failed is true", () => {
    render(<SummaryChecklist currentStep="ActionItems" failed chunkIndex={0} chunkTotal={1} />);
    const activeLabel = screen.getByText("Finding action items");
    expect(activeLabel.className).toContain("text-red-600");
    expect(screen.getByText("Extracting topics & summary").className).toContain("line-through");
  });

  it("omits the chunk-progress line when there is only one chunk", () => {
    render(<SummaryChecklist currentStep="ActionItems" chunkIndex={0} chunkTotal={1} />);
    expect(screen.queryByText(/part \d+ of \d+/i)).not.toBeInTheDocument();
  });

  it("shows the chunk-progress line for a multi-chunk transcript", () => {
    render(<SummaryChecklist currentStep="ActionItems" chunkIndex={1} chunkTotal={3} />);
    expect(screen.getByText("Part 2 of 3")).toBeInTheDocument();
  });
});
