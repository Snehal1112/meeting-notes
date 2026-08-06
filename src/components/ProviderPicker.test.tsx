import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProviderPicker } from "./ProviderPicker";
import type { AppConfig } from "@/lib/config";

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  claude_api_key: "sk-test",
  ollama_endpoint: "http://localhost:11434",
  ollama_model: null,
  ollama_num_ctx: null,
  summary_provider: null,
  whisper_model: "base.en",
  data_dir: null,
  ...overrides,
});

describe("ProviderPicker", () => {
  it("reports the chosen provider", () => {
    const onChange = vi.fn();
    render(<ProviderPicker config={config()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /claude/i }));
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("selects the stored choice", () => {
    render(<ProviderPicker config={config({ summary_provider: "claude" })} onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: /claude/i })).toBeChecked();
  });

  it("defaults to ollama when no choice is stored and an endpoint is set", () => {
    render(<ProviderPicker config={config()} onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: /ollama/i })).toBeChecked();
  });

  // Offering a choice that is guaranteed to fail is worse than not offering
  // it, so an unconfigured provider is disabled with the reason shown.
  it("disables claude and gives the reason when no api key is set", () => {
    render(<ProviderPicker config={config({ claude_api_key: null })} onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: /claude/i })).toBeDisabled();
    expect(screen.getByText(/no api key set/i)).toBeInTheDocument();
  });

  it("disables ollama and gives the reason when no endpoint is set", () => {
    render(<ProviderPicker config={config({ ollama_endpoint: null })} onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: /ollama/i })).toBeDisabled();
    expect(screen.getByText(/no endpoint set/i)).toBeInTheDocument();
  });

  it("renders nothing when neither provider is configured", () => {
    const { container } = render(
      <ProviderPicker
        config={config({ claude_api_key: null, ollama_endpoint: null })}
        onChange={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing before the config has loaded", () => {
    const { container } = render(<ProviderPicker config={null} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
