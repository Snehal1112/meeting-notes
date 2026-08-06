import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigDialog } from "./ConfigDialog";
import { getConfig } from "@/lib/config";

vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>("@/lib/config");
  return { ...actual, getConfig: vi.fn() };
});

const EMPTY_CONFIG = {
  claude_api_key: null,
  ollama_endpoint: null,
  ollama_model: null,
  ollama_num_ctx: null,
  summary_provider: null,
  whisper_model: null,
};

describe("ConfigDialog", () => {
  beforeEach(() => {
    vi.mocked(getConfig).mockReset().mockResolvedValue(EMPTY_CONFIG);
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
});
