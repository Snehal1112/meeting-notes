import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getRawConfig, setDataDir, type AppConfig } from "@/lib/config";
import { getDataDir } from "@/lib/storage";
import { countMeetingsAt, migrateMeetings, pickFolder } from "@/lib/dataDir";

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
  data_dir: null,
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
  // The resolved directory actually in use right now (for display), and --
  // once the user picks and confirms a different one -- the override to
  // persist. Kept separate from currentDataDir so merely opening the panel
  // and saving without touching Storage Location leaves data_dir exactly as
  // it was (None keeps resolving to the OS default dynamically instead of
  // getting pinned to whatever path happened to resolve today).
  const [currentDataDir, setCurrentDataDir] = useState("");
  const [selectedDataDir, setSelectedDataDir] = useState<string | null>(null);
  const [pendingNewDir, setPendingNewDir] = useState<string | null>(null);
  const [existingMeetingCount, setExistingMeetingCount] = useState(0);
  // Surfaces a failure from any of the storage-location calls below --
  // pickFolder, countMeetingsAt, or migrateMeetings -- inline. These are
  // async functions wired straight to onClick with no caller to bubble a
  // rejection to, so without this an error would otherwise be an unhandled
  // promise rejection with no visible sign anything went wrong, leaving the
  // user stuck looking at the amber warning box.
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStorageError(null);
    getRawConfig().then((config) => {
      setClaudeApiKey(config.claude_api_key ?? "");
      setOllamaEndpoint(config.ollama_endpoint ?? "");
      setOllamaModel(config.ollama_model ?? "");
      setWhisperModel(config.whisper_model ?? "base.en");
      setLoadedConfig(config);
    });
    getDataDir().then(setCurrentDataDir);
  }, [open]);

  if (!open) return null;

  const handleChangeLocation = async () => {
    setStorageError(null);
    try {
      const selected = await pickFolder();
      if (!selected || typeof selected !== "string") return;
      const count = await countMeetingsAt(currentDataDir);
      if (count > 0) {
        setPendingNewDir(selected);
        setExistingMeetingCount(count);
      } else {
        setSelectedDataDir(selected);
        setCurrentDataDir(selected);
      }
    } catch (err) {
      setStorageError(errorMessage(err));
    }
  };

  const resolvePendingMove = async (shouldMove: boolean) => {
    if (!pendingNewDir) return;
    setStorageError(null);
    try {
      if (shouldMove) {
        await migrateMeetings(currentDataDir, pendingNewDir);
        // Persisted immediately rather than deferred to the Save button:
        // migrateMeetings just performed a real filesystem move, and
        // waiting for Save would strand the moved meetings (config.toml
        // still pointing at the old, now-empty location) if the user
        // instead clicks Skip, closes the panel, or the app crashes before
        // saving. See the design spec's "never silently lose or hide
        // meetings" invariant.
        await setDataDir(pendingNewDir);
      }
      setSelectedDataDir(pendingNewDir);
      setCurrentDataDir(pendingNewDir);
      setPendingNewDir(null);
    } catch (err) {
      // Deliberately leaves pendingNewDir set on failure so the amber
      // warning box (and its Move/Leave/Cancel buttons) stays visible for
      // a retry, instead of silently dropping back to a state that implies
      // nothing was attempted.
      setStorageError(errorMessage(err));
    }
  };

  const handleSave = () => {
    onSave({
      ...loadedConfig,
      claude_api_key: claudeApiKey || null,
      ollama_endpoint: ollamaEndpoint || null,
      ollama_model: ollamaModel || null,
      whisper_model: whisperModel,
      data_dir: selectedDataDir ?? loadedConfig.data_dir,
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
        <div>
          <label className="text-xs font-medium text-muted-foreground">Storage Location</label>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-foreground truncate flex-1">{currentDataDir}</span>
            <Button variant="outline" size="sm" onClick={handleChangeLocation}>
              Change…
            </Button>
          </div>
          {storageError && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {storageError}
            </p>
          )}
        </div>
        {pendingNewDir && existingMeetingCount > 0 && (
          <div className="border border-amber-300 bg-amber-50 rounded-md p-3 text-xs space-y-2">
            <p className="text-amber-900">
              {existingMeetingCount} existing meeting{existingMeetingCount === 1 ? "" : "s"} found
              at the current location. What should happen to them?
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => resolvePendingMove(true)}>
                Move them
              </Button>
              <Button size="sm" variant="ghost" onClick={() => resolvePendingMove(false)}>
                Leave them, use new location only
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingNewDir(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
