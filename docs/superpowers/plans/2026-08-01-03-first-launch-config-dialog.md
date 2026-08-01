# First-Launch Config Dialog Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Show a skippable one-time setup dialog on launch when no config (env vars or file) is found, letting the user optionally set a Claude API key, Ollama endpoint, and whisper model.

**Architecture:** A shadcn `Dialog` shown conditionally based on `config_needs_setup()` (built in plan 02). Saving calls `save_config()`; skipping just closes the dialog without writing anything, so it re-prompts next launch until configured or permanently dismissed via a "don't ask again" flag.

**Tech Stack:** React, TypeScript, shadcn/ui (`Dialog`, `Input`, `Button`)

---

### Task 1: Build the config dialog component

**Files:**
- Create: `src/components/ConfigDialog.tsx`
- Create: `src/components/ConfigDialog.test.tsx`

- [x] **Step 1: Write failing component test**

```tsx
// src/components/ConfigDialog.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ConfigDialog } from "./ConfigDialog";

describe("ConfigDialog", () => {
  it("calls onSave with entered values", () => {
    const onSave = vi.fn();
    render(<ConfigDialog open onSave={onSave} onSkip={() => {}} />);
    fireEvent.change(screen.getByLabelText(/claude api key/i), {
      target: { value: "sk-abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ claude_api_key: "sk-abc" })
    );
  });

  it("calls onSkip when skip is clicked", () => {
    const onSkip = vi.fn();
    render(<ConfigDialog open onSave={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    expect(onSkip).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- ConfigDialog`
Expected: FAIL — `ConfigDialog` doesn't exist yet.

- [x] **Step 3: Implement the component**

```tsx
// src/components/ConfigDialog.tsx
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
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- ConfigDialog`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/components/ConfigDialog.tsx src/components/ConfigDialog.test.tsx
git commit -m "feat: add first-launch config dialog component"
```

---

### Task 2: Wire dialog visibility to config_needs_setup on app load

**Files:**
- Modify: `src/App.tsx`

- [x] **Step 1: Add state + effect to check config on mount**

```tsx
// src/App.tsx (additions)
import { useEffect, useState } from "react";
import { ConfigDialog } from "@/components/ConfigDialog";
import { configNeedsSetup, saveConfig, type AppConfig } from "@/lib/config";

function App() {
  const [showConfigDialog, setShowConfigDialog] = useState(false);

  useEffect(() => {
    configNeedsSetup().then(setShowConfigDialog);
  }, []);

  const handleSave = async (config: AppConfig) => {
    await saveConfig(config);
    setShowConfigDialog(false);
  };

  const handleSkip = () => setShowConfigDialog(false);

  return (
    <div className="h-screen flex flex-col rounded-lg overflow-hidden border">
      <TitleBar />
      <div className="flex-1 p-4">{/* widget content */}</div>
      <ConfigDialog open={showConfigDialog} onSave={handleSave} onSkip={handleSkip} />
    </div>
  );
}
```

- [x] **Step 2: Manual verification**

Run: `bun run tauri dev` with no `MEETING_NOTES_*` env vars set and no existing `~/.config/meeting-notes/config.toml`.
Expected: dialog appears on launch. Fill in a value and click Save → dialog closes, `~/.config/meeting-notes/config.toml` is created with that value. Relaunch → dialog does not reappear.

- [x] **Step 3: Verify skip behavior**

Delete the config file, relaunch, click Skip.
Expected: dialog closes, no config file written, dialog reappears on next relaunch (expected — matches "skippable, re-prompts" design).

- [x] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: show first-launch config dialog when no config is present"
```
