import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ResumePrompt } from "./ResumePrompt";
import type { MeetingMeta } from "@/lib/storage";

const orphan = (overrides: Partial<MeetingMeta> = {}): MeetingMeta => ({
  id: "2026-08-02_090000_standup",
  title: "Standup",
  created_at: "2026-08-02T09:00:00Z",
  duration_seconds: null,
  status: "Recording",
  used_system_audio: true,
  ...overrides,
});

describe("ResumePrompt", () => {
  it("lists orphaned meetings and calls onResume when clicked", () => {
    const onResume = vi.fn();
    render(<ResumePrompt meetings={[orphan()]} onResume={onResume} onDismiss={() => {}} />);

    expect(screen.getByText(/standup/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalledWith("2026-08-02_090000_standup");
  });

  it("calls onDismiss when dismiss is clicked", () => {
    const onDismiss = vi.fn();
    render(<ResumePrompt meetings={[orphan()]} onResume={() => {}} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("renders nothing when there are no orphaned meetings", () => {
    const { container } = render(
      <ResumePrompt meetings={[]} onResume={() => {}} onDismiss={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Recordings started without a title are stored with an empty title, so
  // falling back to the id keeps the row identifiable instead of blank.
  it("falls back to the meeting id when the recording has no title", () => {
    render(
      <ResumePrompt meetings={[orphan({ title: "" })]} onResume={() => {}} onDismiss={() => {}} />
    );
    expect(screen.getByText("2026-08-02_090000_standup")).toBeInTheDocument();
  });

  it("renders a resume control for each orphaned meeting", () => {
    render(
      <ResumePrompt
        meetings={[orphan(), orphan({ id: "2026-08-02_100000_retro", title: "Retro" })]}
        onResume={() => {}}
        onDismiss={() => {}}
      />
    );
    expect(screen.getAllByRole("button", { name: /resume/i })).toHaveLength(2);
  });
});
