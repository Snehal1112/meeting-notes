import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Toaster } from "sonner";
import { MeetingHistory } from "./MeetingHistory";
import type { MeetingHistoryEntry } from "@/lib/history";

function renderWithToaster(props: Parameters<typeof MeetingHistory>[0]) {
  return render(
    <>
      <Toaster />
      <MeetingHistory {...props} />
    </>
  );
}

const getMeetingHistory = vi.fn();
const revealInFileManager = vi.fn();
const deleteMeeting = vi.fn();
const openSummary = vi.fn();
const summarizeMeeting = vi.fn();

vi.mock("@/lib/history", () => ({
  getMeetingHistory: () => getMeetingHistory(),
  deleteMeeting: (id: string) => deleteMeeting(id),
  revealInFileManager: (id: string) => revealInFileManager(id),
}));

vi.mock("@/lib/storage", () => ({
  openSummary: (id: string) => openSummary(id),
}));

vi.mock("@/lib/summary", () => ({
  summarizeMeeting: (id: string) => summarizeMeeting(id),
}));

const entry = (overrides: Partial<MeetingHistoryEntry> = {}): MeetingHistoryEntry => ({
  id: "2026-08-02_090000_standup",
  title: "Standup",
  created_at: "2026-08-02T09:00:00Z",
  duration_seconds: 600,
  status: "Done",
  used_system_audio: true,
  meeting_type: "AutoDetect",
  error_message: null,
  snippet: "Shipped the roadmap.",
  ...overrides,
});

beforeEach(() => {
  revealInFileManager.mockClear();
  deleteMeeting.mockReset().mockResolvedValue(undefined);
  openSummary.mockClear();
  summarizeMeeting.mockClear();
});

describe("MeetingHistory", () => {
  it("shows a loading state before the history resolves", () => {
    getMeetingHistory.mockReturnValue(new Promise(() => {}));
    render(<MeetingHistory onBack={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an empty state with no search/filter bar when there are no meetings", async () => {
    getMeetingHistory.mockResolvedValue([]);
    render(<MeetingHistory onBack={() => {}} />);

    expect(await screen.findByText(/no meetings yet/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it("does not show the empty state once meetings load", async () => {
    getMeetingHistory.mockResolvedValue([entry()]);
    render(<MeetingHistory onBack={() => {}} />);

    await vi.waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/no meetings yet/i)).not.toBeInTheDocument();
  });

  it("calls onBack when the back button is clicked", async () => {
    getMeetingHistory.mockResolvedValue([]);
    const onBack = vi.fn();
    render(<MeetingHistory onBack={onBack} />);

    fireEvent.click(await screen.findByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("calls openSummary when a row's title is clicked", async () => {
    getMeetingHistory.mockResolvedValue([entry()]);
    render(<MeetingHistory onBack={() => {}} />);

    fireEvent.click(await screen.findByText("Standup"));
    expect(openSummary).toHaveBeenCalledWith(entry().id);
  });

  it("calls revealInFileManager from a row's actions menu", async () => {
    const user = userEvent.setup();
    getMeetingHistory.mockResolvedValue([entry()]);
    render(<MeetingHistory onBack={() => {}} />);

    await user.click(await screen.findByRole("button", { name: /actions/i }));
    await user.click(await screen.findByText(/reveal in file manager/i));

    expect(revealInFileManager).toHaveBeenCalledWith(entry().id);
  });

  describe("with several meetings", () => {
    function seedEntries(count: number, overrides: (i: number) => Partial<MeetingHistoryEntry> = () => ({})) {
      return Array.from({ length: count }, (_, i) =>
        entry({
          id: `meeting-${i}`,
          title: `Meeting ${i}`,
          ...overrides(i),
        })
      );
    }

    it("shows the search and filter bar once there is at least one meeting", async () => {
      getMeetingHistory.mockResolvedValue(seedEntries(1));
      render(<MeetingHistory onBack={() => {}} />);
      expect(await screen.findByPlaceholderText(/search/i)).toBeInTheDocument();
    });

    it("shows at most 5 rows per page", async () => {
      getMeetingHistory.mockResolvedValue(seedEntries(7));
      render(<MeetingHistory onBack={() => {}} />);

      await screen.findByText("Meeting 0");
      expect(screen.getAllByText(/^Meeting \d$/)).toHaveLength(5);
    });

    it("narrows results by title search and resets to page 1", async () => {
      getMeetingHistory.mockResolvedValue(seedEntries(7));
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Meeting 0");

      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "Meeting 6" } });

      expect(await screen.findByText("Meeting 6")).toBeInTheDocument();
      expect(screen.queryByText("Meeting 0")).not.toBeInTheDocument();
    });

    it("combines search with the status filter (AND logic)", async () => {
      getMeetingHistory.mockResolvedValue([
        entry({ id: "a", title: "Retro A", status: "Done", snippet: "done" }),
        entry({ id: "b", title: "Retro B", status: "Failed", snippet: null, error_message: "boom" }),
      ]);
      const user = userEvent.setup();
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Retro A");

      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "Retro" } });
      await user.click(screen.getByLabelText(/status/i));
      await user.click(await screen.findByRole("option", { name: "Failed" }));

      expect(await screen.findByText("Retro B")).toBeInTheDocument();
      expect(screen.queryByText("Retro A")).not.toBeInTheDocument();
    });

    it("disables Previous on the first page and Next on the last page", async () => {
      getMeetingHistory.mockResolvedValue(seedEntries(7));
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Meeting 0");

      const previous = screen.getByLabelText(/go to previous page/i);
      const next = screen.getByLabelText(/go to next page/i);
      expect(previous).toHaveClass("pointer-events-none");
      expect(next).not.toHaveClass("pointer-events-none");

      await userEvent.setup().click(next);

      expect(await screen.findByText("Meeting 5")).toBeInTheDocument();
      expect(screen.getByLabelText(/go to next page/i)).toHaveClass("pointer-events-none");
      expect(screen.getByLabelText(/go to previous page/i)).not.toHaveClass("pointer-events-none");
    });

    it("does not show pagination controls when everything fits on one page", async () => {
      getMeetingHistory.mockResolvedValue(seedEntries(3));
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Meeting 0");
      expect(screen.queryByLabelText(/go to next page/i)).not.toBeInTheDocument();
    });
  });

  describe("Retry", () => {
    it("calls onRetryMeeting with the failed meeting when Retry is clicked", async () => {
      const failed = entry({ status: "Failed", snippet: null, error_message: "boom" });
      getMeetingHistory.mockResolvedValue([failed]);
      const onRetryMeeting = vi.fn();
      render(<MeetingHistory onBack={() => {}} onRetryMeeting={onRetryMeeting} />);

      fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

      expect(onRetryMeeting).toHaveBeenCalledWith(expect.objectContaining({ id: failed.id }));
    });
  });

  describe("Re-run summarization", () => {
    it("calls summarizeMeeting with the meeting id from the actions menu", async () => {
      const user = userEvent.setup();
      summarizeMeeting.mockResolvedValue({});
      getMeetingHistory.mockResolvedValue([entry()]);
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Standup");

      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(await screen.findByText(/re-run summarization/i));

      expect(summarizeMeeting).toHaveBeenCalledWith(entry().id);
    });
  });

  describe("Delete", () => {
    it("removes the row immediately when Delete is clicked", async () => {
      const user = userEvent.setup();
      getMeetingHistory.mockResolvedValue([entry()]);
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Standup");

      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(await screen.findByText(/^delete$/i));

      expect(screen.queryByText("Standup")).not.toBeInTheDocument();
    });

    it("does not call deleteMeeting until the undo window elapses", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      getMeetingHistory.mockResolvedValue([entry()]);
      renderWithToaster({ onBack: () => {} });
      await screen.findByText("Standup");

      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(await screen.findByText(/^delete$/i));
      expect(deleteMeeting).not.toHaveBeenCalled();

      vi.advanceTimersByTime(6000);
      expect(deleteMeeting).toHaveBeenCalledWith(entry().id);
      vi.useRealTimers();
    });

    it("restores the row and never calls deleteMeeting when Undo is clicked", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      getMeetingHistory.mockResolvedValue([entry()]);
      renderWithToaster({ onBack: () => {} });
      await screen.findByText("Standup");

      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(await screen.findByText(/^delete$/i));
      await user.click(await screen.findByText(/undo/i));

      vi.advanceTimersByTime(6000);
      expect(deleteMeeting).not.toHaveBeenCalled();
      expect(screen.getByText("Standup")).toBeInTheDocument();
      vi.useRealTimers();
    });
  });
});
