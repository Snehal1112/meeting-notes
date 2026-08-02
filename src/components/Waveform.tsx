import { useEffect, useRef } from "react";

interface WaveformProps {
  active: boolean;
}

export function Waveform({ active }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active) return;

    let audioContext: AudioContext | undefined;
    let stream: MediaStream | undefined;

    const setup = async () => {
      try {
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
      } catch {
        // getUserMedia not available or permission denied in test/headless environments.
        // Component still renders the canvas, but no audio visualization occurs.
      }
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
