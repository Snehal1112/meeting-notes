import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { AppConfig } from "@/lib/config";

interface ConfigDialogProps {
  open: boolean;
  onSave: (config: AppConfig) => void;
  onSkip: () => void;
}

const WHISPER_MODELS = ["tiny.en", "base.en", "small.en"];

export function ConfigDialog({ open, onSave, onSkip }: ConfigDialogProps) {
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [ollamaEndpoint, setOllamaEndpoint] = useState("");
  const [whisperModel, setWhisperModel] = useState("base.en");

  const handleSave = () => {
    onSave({
      claude_api_key: claudeApiKey || null,
      ollama_endpoint: ollamaEndpoint || null,
      whisper_model: whisperModel,
    });
  };

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set up Meeting Notes</DialogTitle>
        </DialogHeader>
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
        <DialogFooter>
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
