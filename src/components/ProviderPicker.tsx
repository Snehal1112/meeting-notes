import type { AppConfig } from "@/lib/config";

export type ProviderName = "ollama" | "claude";

interface ProviderPickerProps {
  config: AppConfig | null;
  onChange: (provider: ProviderName) => void;
}

// Lets the user trade privacy and cost against summary depth per meeting,
// rather than that trade-off being fixed by config precedence.
export function ProviderPicker({ config, onChange }: ProviderPickerProps) {
  if (!config) return null;

  const ollamaReady = Boolean(config.ollama_endpoint);
  const claudeReady = Boolean(config.claude_api_key);
  if (!ollamaReady && !claudeReady) return null;

  // Mirrors the backend's resolution: an explicit choice only counts when
  // that provider is configured, otherwise Ollama wins when available.
  const stored = config.summary_provider?.toLowerCase();
  const selected: ProviderName =
    stored === "claude" && claudeReady
      ? "claude"
      : stored === "ollama" && ollamaReady
        ? "ollama"
        : ollamaReady
          ? "ollama"
          : "claude";

  const options: { value: ProviderName; label: string; ready: boolean; reason: string }[] = [
    { value: "ollama", label: "Ollama", ready: ollamaReady, reason: "no endpoint set" },
    { value: "claude", label: "Claude", ready: claudeReady, reason: "no API key set" },
  ];

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span>Summarize with:</span>
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-1">
          <input
            type="radio"
            name="summary-provider"
            value={option.value}
            checked={selected === option.value}
            disabled={!option.ready}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
          {!option.ready && <span>({option.reason})</span>}
        </label>
      ))}
    </div>
  );
}
