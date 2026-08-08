import { useEffect, useRef } from "react";

interface WaveformProps {
  active: boolean;
  // Renders a smaller canvas with fewer, chunkier bars for the Recording
  // pill's tight 60x196 footprint -- the full-size canvas below is sized for
  // the old, roomier card layout and would overflow the pill.
  compact?: boolean;
  // Rotates the compact waveform so its bars run top-to-bottom instead of
  // left-to-right, for the vertical Recording capsule (60px wide) -- the
  // default horizontal layout (90px wide) would overflow that width. Only
  // meaningful together with `compact`; the full-size waveform never
  // appears in a vertical layout, so it ignores this prop.
  orientation?: "horizontal" | "vertical";
}

// Eases a displayed value a `factor` fraction of the way toward `target` —
// the standard exponential-smoothing technique audio visualizers use to
// avoid snapping instantly to each new raw sample.
export function easeTowards(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

// Maps a 0-1 volume intensity to one of the waveform's three theme colors.
// destructiveColor is a parameter (not hardcoded) because the draw loop
// reads it live from the --destructive CSS custom property, which can
// change with the theme.
export function colorForIntensity(intensity: number, destructiveColor: string): string {
  if (intensity < 0.15) return "hsl(220 9% 80%)";
  if (intensity < 0.5) return "#F59E0B";
  return destructiveColor;
}

export function Waveform({ active, compact = false, orientation = "horizontal" }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | undefined>(undefined);

  const vertical = compact && orientation === "vertical";
  // Vertical is the horizontal compact canvas' own dimensions swapped, not a
  // new pair of numbers -- same total bar budget, just rotated to fit the
  // capsule's 60px width instead of its 196px height.
  const width = vertical ? 20 : compact ? 90 : 320;
  const height = vertical ? 90 : compact ? 20 : 60;
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
        // Per-bar smoothed intensity, eased toward the raw reading each
        // frame by easeTowards (see below) -- this is what makes the bars
        // glide instead of snapping to each new sample. Lives for the
        // lifetime of this effect run (same as dataArray above), not in a
        // ref: draw() closes over it directly.
        const displayed = new Float32Array(analyser.frequencyBinCount);
        const SMOOTHING_FACTOR = 0.35;

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
          // Bars are always distributed along the "cross" axis (one slot per
          // frequency bin) and extend along the "main" axis by intensity.
          // Horizontal: cross = width (x), main = height (y) -- the
          // original layout. Vertical: cross = height (y), main = width (x)
          // -- the same drawing logic, rotated 90 degrees.
          const crossAxis = vertical ? canvas.height : canvas.width;
          const mainAxis = vertical ? canvas.width : canvas.height;
          const barSpacing = crossAxis / dataArray.length;
          // Read the live --destructive custom property fresh on every
          // frame (rather than once outside the loop) so a light/dark theme
          // toggle mid-recording is picked up immediately. This repo's
          // --destructive resolves to a plain CSS color value already
          // usable as-is -- unlike the old HSL-triplet convention, it must
          // NOT be wrapped in hsl(...), which would be an invalid color.
          //
          // The read can come back empty (the property not applied yet on the
          // first frames, or a stylesheet that has not landed). Assigning ""
          // to strokeStyle is silently ignored by the Canvas API, which would
          // leave the loudest bars painted in whatever strokeStyle was last set
          // -- black on the very first frame -- so fall back to the token's
          // own current light-theme value.
          const destructiveColor =
            getComputedStyle(document.documentElement).getPropertyValue("--destructive").trim() ||
            "oklch(0.577 0.245 27.325)";
          const center = mainAxis / 2;
          // lineWidth/lineCap don't vary per bar (barSpacing is fixed above
          // the loop), so they're set once here rather than redundantly on
          // every iteration -- canvas 2D context state persists across draw
          // calls.
          ctx.lineWidth = barSpacing * 0.6;
          ctx.lineCap = "round";
          dataArray.forEach((value, i) => {
            const target = value / 255;
            displayed[i] = easeTowards(displayed[i], target, SMOOTHING_FACTOR);
            // Reserve lineWidth's worth of budget (barSpacing * 0.6) so the
            // round cap's overhang (lineWidth / 2 past each endpoint) never
            // gets clipped by the canvas edge at max volume -- an uncapped
            // bar would otherwise flatten to a square top exactly in the
            // loud/red tier, the opposite of the intended look.
            const barLength = Math.max(minBarHeight, displayed[i] * (mainAxis - barSpacing * 0.6));
            const pos = i * barSpacing + barSpacing / 2;
            ctx.beginPath();
            if (vertical) {
              ctx.moveTo(center - barLength / 2, pos);
              ctx.lineTo(center + barLength / 2, pos);
            } else {
              ctx.moveTo(pos, center - barLength / 2);
              ctx.lineTo(pos, center + barLength / 2);
            }
            ctx.strokeStyle = colorForIntensity(displayed[i], destructiveColor);
            ctx.stroke();
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
  }, [active, fftSize, minBarHeight, orientation]);

  return <canvas ref={canvasRef} width={width} height={height} />;
}
