import { useEffect, useRef } from "react";

interface WaveformProps {
  active: boolean;
  // Renders a smaller canvas with fewer, chunkier bars for the Recording
  // pill's tight 224x56 footprint -- the full-size canvas below is sized for
  // the old, roomier card layout and would overflow the pill.
  compact?: boolean;
}

export function Waveform({ active, compact = false }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | undefined>(undefined);

  const width = compact ? 90 : 320;
  const height = compact ? 20 : 60;
  const fftSize = compact ? 32 : 64;
  const minBarHeight = compact ? 1.5 : 2;

  useEffect(() => {
    if (!active) return;

    let audioContext: AudioContext | undefined;
    let stream: MediaStream | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Check if effect was cancelled while awaiting permission.
        if (cancelled) {
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }

        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = fftSize;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        // Check if effect was cancelled before starting draw loop.
        if (cancelled) {
          audioContext.close();
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }

        const draw = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          analyser.getByteFrequencyData(dataArray);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const barWidth = canvas.width / dataArray.length;
          // Read the live --destructive custom property fresh on every
          // frame (rather than once outside the loop) so a light/dark theme
          // toggle mid-recording is picked up immediately. This repo's
          // --destructive resolves to a plain CSS color value already
          // usable as-is -- unlike the old HSL-triplet convention, it must
          // NOT be wrapped in hsl(...), which would be an invalid color.
          const destructiveColor = getComputedStyle(document.documentElement)
            .getPropertyValue("--destructive")
            .trim();
          dataArray.forEach((value, i) => {
            const intensity = value / 255;
            const barHeight = Math.max(minBarHeight, intensity * canvas.height);
            ctx.fillStyle =
              intensity < 0.15 ? "hsl(220 9% 80%)" : intensity < 0.5 ? "#F59E0B" : destructiveColor;
            ctx.beginPath();
            const x = i * barWidth + barWidth / 2;
            const y = canvas.height / 2;
            ctx.arc(x, y, barHeight / 2, 0, Math.PI * 2);
            ctx.fill();
          });
          rafRef.current = requestAnimationFrame(draw);
        };
        draw();
      } catch (err) {
        // getUserMedia not available or permission denied in test/headless environments.
        // Component still renders the canvas, but no audio visualization occurs.
        console.warn("Waveform: mic capture unavailable", err);
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
      audioContext?.close();
    };
  }, [active, fftSize, minBarHeight]);

  return <canvas ref={canvasRef} width={width} height={height} />;
}
