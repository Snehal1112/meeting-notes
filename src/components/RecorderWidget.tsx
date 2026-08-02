import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startRecording, stopRecording } from "@/lib/recording";
import { Waveform } from "@/components/Waveform";

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
    const outputPath = `${meetingsBaseDir()}/${meetingDirRef.current}/audio.wav`;
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
        <Waveform active={state === "recording"} />
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
function meetingsBaseDir(): string {
  return "/tmp/meeting-notes/meetings";
}
