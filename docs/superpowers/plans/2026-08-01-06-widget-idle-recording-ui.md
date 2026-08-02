# Widget UI — Idle & Recording States Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the Idle state (title input + Start button) and Recording state (live waveform, elapsed timer, Stop button) of the floating widget, wired to the recording commands from plans 04/05.

**Architecture:** A `RecorderWidget` component owns a small state machine (`idle | recording | processing | done`, though only `idle`/`recording` are wired in this plan) via `useState`. The waveform uses the Web Audio API `AnalyserNode` on the mic `MediaStream` (separate from the Rust-side PipeWire capture — this is purely for the visual, matching the reference image's reactive dot waveform).

**Tech Stack:** React, TypeScript, shadcn/ui (`Button`, `Input`), Web Audio API

---

### Task 1: Idle state — title input + Start button

**Files:**
- Create: `src/components/RecorderWidget.tsx`
- Create: `src/components/RecorderWidget.test.tsx`
- Modify: `src/App.tsx`

- [x] **Step 1: Write failing test for idle state**

```tsx
// src/components/RecorderWidget.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RecorderWidget } from "./RecorderWidget";

vi.mock("@/lib/recording", () => ({
  startRecording: vi.fn().mockResolvedValue(true),
  stopRecording: vi.fn().mockResolvedValue("/tmp/audio.wav"),
}));

describe("RecorderWidget idle state", () => {
  it("shows a title input and Start Recording button by default", () => {
    render(<RecorderWidget />);
    expect(screen.getByPlaceholderText(/meeting title/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start recording/i })).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- RecorderWidget`
Expected: FAIL — `RecorderWidget` doesn't exist.

- [x] **Step 3: Implement idle state**

```tsx
// src/components/RecorderWidget.tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type WidgetState = "idle" | "recording" | "processing" | "done";

export function RecorderWidget() {
  const [state, setState] = useState<WidgetState>("idle");
  const [title, setTitle] = useState("");

  if (state === "idle") {
    return (
      <div className="flex flex-col gap-3 h-full justify-center">
        <Input
          placeholder="Meeting title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button onClick={() => setState("recording")}>Start Recording</Button>
      </div>
    );
  }

  return <div>Recording state placeholder</div>;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- RecorderWidget`
Expected: PASS

- [x] **Step 5: Mount in App.tsx**

Replace the placeholder `{/* widget content */}` div in `src/App.tsx` with `<RecorderWidget />`.

- [x] **Step 6: Commit**

```bash
git add src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx src/App.tsx
git commit -m "feat: add idle state to recorder widget"
```

---

### Task 2: Recording state — timer, Stop button, wired to backend

**Files:**
- Modify: `src/components/RecorderWidget.tsx`
- Modify: `src/components/RecorderWidget.test.tsx`

- [x] **Step 1: Write failing test for start → recording transition**

```tsx
it("calls startRecording and shows the recording state on Start click", async () => {
  const { startRecording } = await import("@/lib/recording");
  render(<RecorderWidget />);
  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
  expect(startRecording).toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: /stop recording/i })).toBeInTheDocument();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- RecorderWidget`
Expected: FAIL — Start button doesn't call `startRecording` yet.

- [x] **Step 3: Implement recording state with elapsed timer**

```tsx
// src/components/RecorderWidget.tsx (rewrite)
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startRecording, stopRecording } from "@/lib/recording";

type WidgetState = "idle" | "recording" | "processing" | "done";

function meetingDirName(title: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
  return slug ? `${ts}_${slug}` : ts;
}

export function RecorderWidget() {
  const [state, setState] = useState<WidgetState>("idle");
  const [title, setTitle] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [micOnlyWarning, setMicOnlyWarning] = useState(false);
  const meetingDirRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (state === "recording") {
      timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state]);

  const handleStart = async () => {
    meetingDirRef.current = meetingDirName(title);
    const outputPath = `${await meetingsBaseDir()}/${meetingDirRef.current}/audio.wav`;
    setElapsedSeconds(0);
    const usedSystemAudio = await startRecording(outputPath);
    setMicOnlyWarning(!usedSystemAudio);
    setState("recording");
  };

  const handleStop = async () => {
    await stopRecording();
    setState("processing");
  };

  const formattedTime = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(
    elapsedSeconds % 60
  ).padStart(2, "0")}`;

  if (state === "idle") {
    return (
      <div className="flex flex-col gap-3 h-full justify-center">
        <Input
          placeholder="Meeting title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button onClick={handleStart}>Start Recording</Button>
      </div>
    );
  }

  if (state === "recording") {
    return (
      <div className="flex flex-col gap-3 h-full justify-center items-center">
        {micOnlyWarning && (
          <span className="text-xs text-amber-600">
            System audio unavailable — recording mic only
          </span>
        )}
        <div className="text-2xl font-mono">{formattedTime}</div>
        <Button variant="destructive" onClick={handleStop}>
          Stop Recording
        </Button>
      </div>
    );
  }

  return <div>Processing/Done placeholder (built in later plans)</div>;
}

// Placeholder resolved for real in plan 07 (meeting file storage).
async function meetingsBaseDir(): Promise<string> {
  return "/tmp/meeting-notes/meetings";
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- RecorderWidget`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/components/RecorderWidget.tsx src/components/RecorderWidget.test.tsx
git commit -m "feat: wire recording state to backend with elapsed timer"
```

---

### Task 3: Live reactive waveform visualization

**Files:**
- Create: `src/components/Waveform.tsx`
- Create: `src/components/Waveform.test.tsx`
- Modify: `src/components/RecorderWidget.tsx`

- [x] **Step 1: Write failing test that Waveform renders a canvas**

```tsx
// src/components/Waveform.test.tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Waveform } from "./Waveform";

describe("Waveform", () => {
  it("renders a canvas element", () => {
    const { container } = render(<Waveform active={false} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test -- Waveform`
Expected: FAIL — `Waveform` doesn't exist.

- [x] **Step 3: Implement Waveform using AnalyserNode**

```tsx
// src/components/Waveform.tsx
import { useEffect, useRef } from "react";

interface WaveformProps {
  active: boolean;
}

export function Waveform({ active }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>();

  useEffect(() => {
    if (!active) return;

    let audioContext: AudioContext | undefined;
    let stream: MediaStream | undefined;

    const setup = async () => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const draw = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        analyser.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const barWidth = canvas.width / dataArray.length;
        dataArray.forEach((value, i) => {
          const height = Math.max(2, (value / 255) * canvas.height);
          ctx.fillStyle = "#71717a";
          ctx.beginPath();
          const x = i * barWidth + barWidth / 2;
          const y = canvas.height / 2;
          ctx.arc(x, y, height / 2, 0, Math.PI * 2);
          ctx.fill();
        });
        rafRef.current = requestAnimationFrame(draw);
      };
      draw();
    };

    setup();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      audioContext?.close();
    };
  }, [active]);

  return <canvas ref={canvasRef} width={320} height={60} />;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test -- Waveform`
Expected: PASS

- [x] **Step 5: Mount Waveform in the recording state view**

```tsx
// src/components/RecorderWidget.tsx (inside the "recording" state return block, above the timer)
<Waveform active={state === "recording"} />
```

Add the import: `import { Waveform } from "@/components/Waveform";`

- [x] **Step 6: Manual verification**

Run: `bun run tauri dev`, click Start Recording, speak into the mic.
Expected: dot-based waveform reacts visually to voice, matching the reference image's style.

- [x] **Step 7: Commit**

```bash
git add src/components/Waveform.tsx src/components/Waveform.test.tsx src/components/RecorderWidget.tsx
git commit -m "feat: add live reactive waveform visualization during recording"
```
