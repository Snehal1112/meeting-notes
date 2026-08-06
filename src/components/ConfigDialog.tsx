import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getConfig, type AppConfig } from "@/lib/config";

interface ConfigDialogProps {
  open: boolean;
  onSave: (config: AppConfig) => void;
  onSkip: () => void;
}

const WHISPER_MODELS = ["tiny.en", "base.en", "small.en"];

const EMPTY_CONFIG: AppConfig = {
  claude_api_key: null,
  ollama_endpoint: null,
  ollama_model: null,
  ollama_num_ctx: null,
  summary_provider: null,
  whisper_model: null,
};

// A plain inline panel, not a modal dialog. A real modal (overlay + portal +
// dismiss-on-outside-click) fights the always-on-top widget's draggable
// title bar -- every drag reads as an "outside click" and closes it. This
// panel is just conditionally-rendered content in the normal layout flow,
// so the title bar above it is never blocked or fought over.
export function ConfigDialog({ open, onSave, onSkip }: ConfigDialogProps) {
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [ollamaEndpoint, setOllamaEndpoint] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [whisperModel, setWhisperModel] = useState("base.en");
  // Fields this panel has no input for (ollama_num_ctx, summary_provider,
  // and -- once Storage Location is added -- data_dir) must round-trip
  // through save unchanged. Holding the last-loaded config lets handleSave
  // spread it as a base instead of hardcoding those fields to null, which
  // would silently wipe them out every time settings are reopened and saved.
  const [loadedConfig, setLoadedConfig] = useState<AppConfig>(EMPTY_CONFIG);

  useEffect(() => {
    if (!open) return;
    getConfig().then((config) => {
      setClaudeApiKey(config.claude_api_key ?? "");
      setOllamaEndpoint(config.ollama_endpoint ?? "");
      setOllamaModel(config.ollama_model ?? "");
      setWhisperModel(config.whisper_model ?? "base.en");
      setLoadedConfig(config);
    });
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    onSave({
      ...loadedConfig,
      claude_api_key: claudeApiKey || null,
      ollama_endpoint: ollamaEndpoint || null,
      ollama_model: ollamaModel || null,
      whisper_model: whisperModel,
    });
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="font-heading text-sm font-semibold tracking-tight">Set up Meeting Notes</h2>
      <div className="space-y-3">
        <div>
          <label htmlFor="claude-key" className="text-xs font-medium text-muted-foreground">
            Claude API Key (optional)
          </label>
          <Input
            id="claude-key"
            type="password"
            value={claudeApiKey}
            onChange={(e) => setClaudeApiKey(e.target.value)}
            placeholder="sk-ant-..."
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="ollama-endpoint" className="text-xs font-medium text-muted-foreground">
            Ollama Endpoint (optional)
          </label>
          <Input
            id="ollama-endpoint"
            value={ollamaEndpoint}
            onChange={(e) => setOllamaEndpoint(e.target.value)}
            placeholder="http://localhost:11434"
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="ollama-model" className="text-xs font-medium text-muted-foreground">
            Ollama model (optional)
          </label>
          <Input
            id="ollama-model"
            value={ollamaModel}
            onChange={(e) => setOllamaModel(e.target.value)}
            placeholder="llama3"
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="whisper-model" className="text-xs font-medium text-muted-foreground">
            Whisper model
          </label>
          <select
            id="whisper-model"
            className="mt-1 w-full border rounded-md h-9 px-2 text-sm"
            value={whisperModel}
            onChange={(e) => setWhisperModel(e.target.value)}
          >
            {WHISPER_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onSkip}>
          Skip
        </Button>
        <Button onClick={handleSave}>Save</Button>
      </div>
    </div>
  );
}
