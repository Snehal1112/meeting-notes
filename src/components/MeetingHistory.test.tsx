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
  revealInFileManager.mockReset().mockResolvedValue(undefined);
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

  it("renders entries sorted by created_at newest first", async () => {
    const old = entry({ id: "old", title: "Old", created_at: "2026-08-01T09:00:00Z" });
    const newer = entry({ id: "newer", title: "Newer", created_at: "2026-08-02T09:00:00Z" });
    const newest = entry({ id: "newest", title: "Newest", created_at: "2026-08-03T09:00:00Z" });
    getMeetingHistory.mockResolvedValue([old, newer, newest]);
    render(<MeetingHistory onBack={() => {}} />);

    await screen.findByText("Newest");
    const titles = screen.getAllByText(/^(Old|Newer|Newest)$/).map((el) => el.textContent);
    expect(titles).toEqual(["Newest", "Newer", "Old"]);
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

  describe("Date filter", () => {
    // "Now" is pinned to a Saturday so that the week/month/last-30 buckets
    // below have a fixed, deterministic boundary to assert against.
    const NOW = new Date("2026-08-15T12:00:00Z");

    it("shows every entry regardless of date when 'Date: All time' is selected", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(NOW);
      getMeetingHistory.mockResolvedValue([
        entry({ id: "today", title: "Today Meeting", created_at: "2026-08-15T08:00:00Z" }),
        entry({ id: "old", title: "Old Meeting", created_at: "2026-06-01T08:00:00Z" }),
      ]);
      render(<MeetingHistory onBack={() => {}} />);

      expect(await screen.findByText("Today Meeting")).toBeInTheDocument();
      expect(screen.getByText("Old Meeting")).toBeInTheDocument();
      vi.useRealTimers();
    });

    it("narrows to only today's meetings when 'Today' is selected", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(NOW);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      getMeetingHistory.mockResolvedValue([
        entry({ id: "today", title: "Today Meeting", created_at: "2026-08-15T08:00:00Z" }),
        entry({ id: "old", title: "Old Meeting", created_at: "2026-07-20T08:00:00Z" }),
      ]);
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("Today Meeting");

      await user.click(screen.getByLabelText(/date/i));
      await user.click(await screen.findByRole("option", { name: "Today" }));

      expect(await screen.findByText("Today Meeting")).toBeInTheDocument();
      expect(screen.queryByText("Old Meeting")).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("narrows to this week's meetings when 'This week' is selected", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(NOW);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      getMeetingHistory.mockResolvedValue([
        // Tuesday of the current (Mon 8/10 - Sun 8/16) week.
        entry({ id: "in-week", title: "In Week Meeting", created_at: "2026-08-11T08:00:00Z" }),
        // Sunday of the previous week.
        entry({ id: "out-week", title: "Out Week Meeting", created_at: "2026-08-09T08:00:00Z" }),
      ]);
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("In Week Meeting");

      await user.click(screen.getByLabelText(/date/i));
      await user.click(await screen.findByRole("option", { name: "This week" }));

      expect(await screen.findByText("In Week Meeting")).toBeInTheDocument();
      expect(screen.queryByText("Out Week Meeting")).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("narrows to this month's meetings when 'This month' is selected", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(NOW);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      getMeetingHistory.mockResolvedValue([
        entry({ id: "in-month", title: "In Month Meeting", created_at: "2026-08-03T08:00:00Z" }),
        entry({ id: "out-month", title: "Out Month Meeting", created_at: "2026-07-20T08:00:00Z" }),
      ]);
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("In Month Meeting");

      await user.click(screen.getByLabelText(/date/i));
      await user.click(await screen.findByRole("option", { name: "This month" }));

      expect(await screen.findByText("In Month Meeting")).toBeInTheDocument();
      expect(screen.queryByText("Out Month Meeting")).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it("narrows to a rolling last-30-days window when 'Last 30 days' is selected", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(NOW);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      getMeetingHistory.mockResolvedValue([
        // 21 days before "now" -- inside the rolling window.
        entry({ id: "in-30", title: "In 30 Days Meeting", created_at: "2026-07-25T08:00:00Z" }),
        // Well outside the rolling window.
        entry({ id: "out-30", title: "Out 30 Days Meeting", created_at: "2026-06-01T08:00:00Z" }),
      ]);
      render(<MeetingHistory onBack={() => {}} />);
      await screen.findByText("In 30 Days Meeting");

      await user.click(screen.getByLabelText(/date/i));
      await user.click(await screen.findByRole("option", { name: "Last 30 days" }));

      expect(await screen.findByText("In 30 Days Meeting")).toBeInTheDocument();
      expect(screen.queryByText("Out 30 Days Meeting")).not.toBeInTheDocument();
      vi.useRealTimers();
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

  // Regression tests for the pagination-resize bug: the window only
  // re-measures when App.tsx's remeasureKey changes, and remeasureKey is
  // driven by onContentChange. Without these calls firing on every content
  // change, the window stays pinned at whatever height it had when History
  // first opened.
  describe("onContentChange", () => {
    function seedEntries(count: number) {
      return Array.from({ length: count }, (_, i) => entry({ id: `meeting-${i}`, title: `Meeting ${i}` }));
    }

    it("fires once the history loads", async () => {
      const onContentChange = vi.fn();
      getMeetingHistory.mockResolvedValue([entry()]);
      render(<MeetingHistory onBack={() => {}} onContentChange={onContentChange} />);

      await screen.findByText("Standup");
      expect(onContentChange).toHaveBeenCalled();
    });

    it("fires again when paginating to a page with a different row count", async () => {
      const onContentChange = vi.fn();
      getMeetingHistory.mockResolvedValue(seedEntries(7));
      render(<MeetingHistory onBack={() => {}} onContentChange={onContentChange} />);
      await screen.findByText("Meeting 0");

      const callsAfterLoad = onContentChange.mock.calls.length;
      await userEvent.setup().click(screen.getByLabelText(/go to next page/i));
      await screen.findByText("Meeting 5");

      expect(onContentChange.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    });

    it("fires again when the search text narrows the results", async () => {
      const onContentChange = vi.fn();
      getMeetingHistory.mockResolvedValue(seedEntries(7));
      render(<MeetingHistory onBack={() => {}} onContentChange={onContentChange} />);
      await screen.findByText("Meeting 0");

      const callsAfterLoad = onContentChange.mock.calls.length;
      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "Meeting 6" } });
      await screen.findByText("Meeting 6");

      expect(onContentChange.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    });

    it("fires again after a re-run refreshes the entries", async () => {
      const onContentChange = vi.fn();
      summarizeMeeting.mockResolvedValue({});
      getMeetingHistory.mockResolvedValueOnce([entry()]).mockResolvedValue([entry({ snippet: "Updated." })]);
      const user = userEvent.setup();
      render(<MeetingHistory onBack={() => {}} onContentChange={onContentChange} />);
      await screen.findByText("Standup");

      const callsAfterLoad = onContentChange.mock.calls.length;
      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(await screen.findByText(/re-run summarization/i));

      await screen.findByText("Updated.");
      expect(onContentChange.mock.calls.length).toBeGreaterThan(callsAfterLoad);
    });
  });

  describe("Reveal in file manager", () => {
    it("shows an error toast when revealInFileManager fails", async () => {
      const user = userEvent.setup();
      revealInFileManager.mockRejectedValue(new Error("no such file or directory"));
      getMeetingHistory.mockResolvedValue([entry()]);
      renderWithToaster({ onBack: () => {} });
      await screen.findByText("Standup");

      await user.click(screen.getByRole("button", { name: /actions/i }));
      await user.click(await screen.findByText(/reveal in file manager/i));

      expect(await screen.findByText(/could not open "standup" in file manager/i)).toBeInTheDocument();
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
