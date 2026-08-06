import { describe, it, expect } from "vitest";
import { resolveProvider } from "./summary";
import type { AppConfig } from "@/lib/config";

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  claude_api_key: null,
  ollama_endpoint: null,
  ollama_model: null,
  ollama_num_ctx: null,
  summary_provider: null,
  whisper_model: null,
  ...overrides,
});

describe("resolveProvider", () => {
  it("returns undefined when config is null", () => {
    expect(resolveProvider(null)).toBeUndefined();
  });

  it("returns undefined when no provider is configured", () => {
    expect(resolveProvider(config())).toBeUndefined();
  });

  it("returns the sole configured provider when only Claude is set up", () => {
    expect(resolveProvider(config({ claude_api_key: "sk-test" }))).toBe("Claude");
  });

  it("returns the sole configured provider when only Ollama is set up", () => {
    expect(resolveProvider(config({ ollama_endpoint: "http://localhost:11434" }))).toBe("Ollama");
  });

  it("prefers Ollama when both are configured and no preference is persisted", () => {
    expect(
      resolveProvider(config({ claude_api_key: "sk-test", ollama_endpoint: "http://localhost:11434" }))
    ).toBe("Ollama");
  });

  it("returns the persisted preference when both are configured and it names an available provider", () => {
    expect(
      resolveProvider(
        config({
          claude_api_key: "sk-test",
          ollama_endpoint: "http://localhost:11434",
          summary_provider: "claude",
        })
      )
    ).toBe("Claude");
  });

  it("falls back to the Ollama-preferring default when the persisted preference names an unavailable provider", () => {
    expect(
      resolveProvider(
        config({
          ollama_endpoint: "http://localhost:11434",
          summary_provider: "claude",
        })
      )
    ).toBe("Ollama");
  });
});
