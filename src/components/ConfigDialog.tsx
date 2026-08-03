import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { AppConfig } from "@/lib/config";

interface ConfigDialogProps {
  open: boolean;
  onSave: (config: AppConfig) => void;
  onSkip: () => void;
}

const WHISPER_MODELS = ["tiny.en", "base.en", "small.en"];

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

  if (!open) return null;

  const handleSave = () => {
    onSave({
      claude_api_key: claudeApiKey || null,
      ollama_endpoint: ollamaEndpoint || null,
      ollama_model: ollamaModel || null,
      ollama_num_ctx: null,
      summary_provider: null,
      whisper_model: whisperModel,
    });
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="font-heading text-sm font-medium">Set up Meeting Notes</h2>
      <div className="space-y-3">
        <div>
          <label htmlFor="claude-key" className="text-xs text-muted-foreground">
            Claude API Key (optional)
          </label>
          <Input
            id="claude-key"
            type="password"
            value={claudeApiKey}
            onChange={(e) => setClaudeApiKey(e.target.value)}
            placeholder="sk-ant-..."
          />
        </div>
        <div>
          <label htmlFor="ollama-endpoint" className="text-xs text-muted-foreground">
            Ollama Endpoint (optional)
          </label>
          <Input
            id="ollama-endpoint"
            value={ollamaEndpoint}
            onChange={(e) => setOllamaEndpoint(e.target.value)}
            placeholder="http://localhost:11434"
          />
        </div>
        <div>
          <label htmlFor="ollama-model" className="text-xs text-muted-foreground">
            Ollama model (optional)
          </label>
          <Input
            id="ollama-model"
            value={ollamaModel}
            onChange={(e) => setOllamaModel(e.target.value)}
            placeholder="llama3"
          />
        </div>
        <div>
          <label htmlFor="whisper-model" className="text-xs text-muted-foreground">
            Whisper model
          </label>
          <select
            id="whisper-model"
            className="w-full border rounded-md h-9 px-2 text-sm"
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
