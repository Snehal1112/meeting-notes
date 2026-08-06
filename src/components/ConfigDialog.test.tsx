import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigDialog } from "./ConfigDialog";
import { getConfig } from "@/lib/config";
import { getDataDir } from "@/lib/storage";
import { countMeetingsAt, migrateMeetings, pickFolder } from "@/lib/dataDir";

vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>("@/lib/config");
  return { ...actual, getConfig: vi.fn() };
});

vi.mock("@/lib/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage")>("@/lib/storage");
  return { ...actual, getDataDir: vi.fn() };
});

vi.mock("@/lib/dataDir", () => ({
  countMeetingsAt: vi.fn(),
  migrateMeetings: vi.fn(),
  pickFolder: vi.fn(),
}));

const EMPTY_CONFIG = {
  claude_api_key: null,
  ollama_endpoint: null,
  ollama_model: null,
  ollama_num_ctx: null,
  summary_provider: null,
  whisper_model: null,
  data_dir: null,
};

const CURRENT_DIR = "/home/user/.local/share/meeting-notes";

describe("ConfigDialog", () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset().mockResolvedValue(EMPTY_CONFIG);
    vi.mocked(getDataDir).mockReset().mockResolvedValue(CURRENT_DIR);
    vi.mocked(countMeetingsAt).mockReset().mockResolvedValue(0);
    vi.mocked(migrateMeetings).mockReset().mockResolvedValue(undefined);
    vi.mocked(pickFolder).mockReset().mockResolvedValue(null);
  });

  it("calls onSave with entered values", async () => {
    const onSave = vi.fn();
    render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/claude api key/i), {
      target: { value: "sk-abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ claude_api_key: "sk-abc" })
    );
  });

  it("saves the entered Ollama model alongside the endpoint", async () => {
    const onSave = vi.fn();
    render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/ollama endpoint/i), {
      target: { value: "http://localhost:11434" },
    });
    fireEvent.change(screen.getByLabelText(/ollama model/i), {
      target: { value: "gemma4:e2b" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        ollama_endpoint: "http://localhost:11434",
        ollama_model: "gemma4:e2b",
      })
    );
  });

  it("saves a null Ollama model when the field is left empty", async () => {
    const onSave = vi.fn();
    render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ ollama_model: null })
    );
  });

  it("calls onSkip when skip is clicked", async () => {
    const onSkip = vi.fn();
    render(<ConfigDialog open onSave={() => {}} onSkip={onSkip} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("prefills fields from the saved config when reopened", async () => {
    vi.mocked(getConfig).mockResolvedValue({
      ...EMPTY_CONFIG,
      claude_api_key: "sk-saved",
      ollama_endpoint: "http://localhost:11434",
      ollama_model: "llama3",
      whisper_model: "small.en",
    });
    render(<ConfigDialog open onSave={() => {}} onSkip={() => {}} />);

    expect(await screen.findByDisplayValue("sk-saved")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://localhost:11434")).toBeInTheDocument();
    expect(screen.getByDisplayValue("llama3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("small.en")).toBeInTheDocument();
  });

  it("preserves fields it has no input for (e.g. summary_provider) when saving", async () => {
    const onSave = vi.fn();
    vi.mocked(getConfig).mockResolvedValue({
      ...EMPTY_CONFIG,
      summary_provider: "ollama",
      ollama_num_ctx: 16384,
    });
    render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ summary_provider: "ollama", ollama_num_ctx: 16384 })
    );
  });

  describe("Storage Location", () => {
    it("shows the current data directory", async () => {
      render(<ConfigDialog open onSave={() => {}} onSkip={() => {}} />);
      expect(await screen.findByText(CURRENT_DIR)).toBeInTheDocument();
    });

    it("adopts the picked folder immediately when there is nothing to migrate", async () => {
      const onSave = vi.fn();
      vi.mocked(pickFolder).mockResolvedValue("/mnt/backup/meeting-notes");
      vi.mocked(countMeetingsAt).mockResolvedValue(0);
      render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
      await screen.findByText(CURRENT_DIR);

      fireEvent.click(screen.getByRole("button", { name: /change/i }));
      expect(await screen.findByText("/mnt/backup/meeting-notes")).toBeInTheDocument();
      expect(screen.queryByText(/existing meeting/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ data_dir: "/mnt/backup/meeting-notes" })
      );
      expect(migrateMeetings).not.toHaveBeenCalled();
    });

    it("warns about existing meetings and moves them on confirmation", async () => {
      const onSave = vi.fn();
      vi.mocked(pickFolder).mockResolvedValue("/mnt/backup/meeting-notes");
      vi.mocked(countMeetingsAt).mockResolvedValue(3);
      render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
      await screen.findByText(CURRENT_DIR);

      fireEvent.click(screen.getByRole("button", { name: /change/i }));
      expect(await screen.findByText(/3 existing meetings found/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /move them/i }));
      await waitFor(() =>
        expect(migrateMeetings).toHaveBeenCalledWith(CURRENT_DIR, "/mnt/backup/meeting-notes")
      );
      expect(await screen.findByText("/mnt/backup/meeting-notes")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ data_dir: "/mnt/backup/meeting-notes" })
      );
    });

    it("adopts the new location without migrating when leaving meetings behind", async () => {
      const onSave = vi.fn();
      vi.mocked(pickFolder).mockResolvedValue("/mnt/backup/meeting-notes");
      vi.mocked(countMeetingsAt).mockResolvedValue(3);
      render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
      await screen.findByText(CURRENT_DIR);

      fireEvent.click(screen.getByRole("button", { name: /change/i }));
      await screen.findByText(/3 existing meetings found/i);
      fireEvent.click(screen.getByRole("button", { name: /leave them/i }));

      expect(await screen.findByText("/mnt/backup/meeting-notes")).toBeInTheDocument();
      expect(migrateMeetings).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ data_dir: "/mnt/backup/meeting-notes" })
      );
    });

    it("does not save a data_dir override when the location was never changed", async () => {
      const onSave = vi.fn();
      render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
      await screen.findByText(CURRENT_DIR);

      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ data_dir: null }));
    });

    it("discards the pending choice on cancel without saving an override", async () => {
      const onSave = vi.fn();
      vi.mocked(pickFolder).mockResolvedValue("/mnt/backup/meeting-notes");
      vi.mocked(countMeetingsAt).mockResolvedValue(3);
      render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
      await screen.findByText(CURRENT_DIR);

      fireEvent.click(screen.getByRole("button", { name: /change/i }));
      await screen.findByText(/3 existing meetings found/i);
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(screen.queryByText(/existing meeting/i)).not.toBeInTheDocument();
      expect(screen.getByText(CURRENT_DIR)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ data_dir: null }));
    });
  });
});
