import { Button } from "@/components/ui/button";
import type { AppConfig } from "@/lib/config";
import { resolveProvider } from "@/lib/summary";

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

  // resolveProvider is shared with RecorderWidget's post-recording run, so
  // what's highlighted here always matches what a recording actually uses.
  // The guard above guarantees at least one provider is configured, so
  // resolveProvider will not actually return undefined here -- the
  // fallback exists only so a future change to either function's
  // availability logic degrades safely instead of throwing.
  const selected = (resolveProvider(config) ?? "Ollama").toLowerCase() as ProviderName;

  const options: { value: ProviderName; label: string; ready: boolean; reason: string }[] = [
    { value: "ollama", label: "Ollama", ready: ollamaReady, reason: "no endpoint set" },
    { value: "claude", label: "Claude", ready: claudeReady, reason: "no API key set" },
  ];

  const unavailable = options.filter((option) => !option.ready);

  // A segmented pill group rather than native radio inputs, so this sits in
  // the same visual language as the dashed-border MeetingTypePicker directly
  // above it in the idle state. The semantics are still a radio group
  // (role="radiogroup" / role="radio" + aria-checked), so keyboard and
  // screen-reader users get the same single-choice affordance a native
  // <input type="radio"> group gave them.
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Summarize with
        </span>
        <div
          role="radiogroup"
          aria-label="Summary provider"
          className="flex w-fit items-center gap-0.5 rounded-full border border-dashed p-0.5"
        >
          {options.map((option) => {
            const isSelected = selected === option.value;
            return (
              <Button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={!option.ready}
                variant={isSelected ? "secondary" : "ghost"}
                size="sm"
                onClick={() => onChange(option.value)}
                className={
                  isSelected
                    ? "rounded-full px-2.5 text-xs"
                    : "rounded-full px-2.5 text-xs text-muted-foreground"
                }
              >
                {option.label}
              </Button>
            );
          })}
        </div>
      </div>
      {unavailable.length > 0 && (
        // Offering a choice that is guaranteed to fail is worse than not
        // offering it, so an unconfigured provider stays disabled above and
        // says why here -- one caption line rather than a parenthetical on
        // each pill, which would blow out the group's width.
        <span className="text-xs text-muted-foreground">
          {unavailable.map((option) => `${option.label}: ${option.reason}`).join(" · ")}
        </span>
      )}
    </div>
  );
}
