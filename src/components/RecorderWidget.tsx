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
