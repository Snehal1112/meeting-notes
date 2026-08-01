#!/usr/bin/env python3
# Diagnostic tool for verifying mic capture works before Plan 04 (audio-capture-mic).
"""Record a short clip via pw-record or arecord, then self-check the WAV for signal."""

import argparse
import math
import signal
import struct
import subprocess
import sys
import wave
from pathlib import Path

# Below this overall RMS, treat the whole recording as silence.
SILENCE_RMS_THRESHOLD = 50.0
# Below this ratio (max chunk RMS / min chunk RMS), treat as suspiciously flat noise.
FLAT_NOISE_RATIO_THRESHOLD = 1.5
# Skip this many leading seconds when computing the flatness ratio, to dodge startup transients.
STARTUP_SKIP_SECONDS = 0.3
CHUNK_SECONDS = 0.5
# Above this absolute DC offset (16-bit scale), the device is delivering a fixed
# offset rather than centered audio -- this specific machine's AMD DMIC array does
# this when the DC-blocked virtual source isn't the one actually being captured.
DC_OFFSET_THRESHOLD = 1000.0
DC_SKIP_SECONDS = 0.5


def parse_args():
    p = argparse.ArgumentParser(
        description="Record a short mic clip and self-check it for silence/flat-noise/real signal.",
    )
    p.add_argument("--duration", type=float, default=5.0, help="Seconds to record (default: 5)")
    p.add_argument(
        "--output",
        default="/tmp/mic-capture-test.wav",
        help="Output WAV path (default: /tmp/mic-capture-test.wav)",
    )
    p.add_argument(
        "--device",
        default=None,
        help="Capture device/target to use. For --backend pipewire, passed as "
        "'pw-record --target <value>'. For --backend alsa, passed as 'arecord -D <value>'. "
        "Default: let the backend auto-select.",
    )
    p.add_argument(
        "--backend",
        choices=["pipewire", "alsa"],
        default="pipewire",
        help="Recording backend to use (default: pipewire)",
    )
    p.add_argument("--rate", type=int, default=16000, help="Sample rate in Hz (default: 16000)")
    p.add_argument("--channels", type=int, default=1, help="Channel count (default: 1)")
    return p.parse_args()


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def record_pipewire(output, duration, rate, channels, device):
    cmd = ["pw-record", "--rate", str(rate), "--channels", str(channels), "--format", "s16"]
    if device:
        cmd += ["--target", device]
    cmd.append(output)

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        die("pw-record not found on PATH. Install pipewire-utils or use --backend alsa.")

    try:
        proc.wait(timeout=duration)
        # Process exited on its own before the duration elapsed, that's a failure.
        _, stderr = proc.communicate()
        die(f"pw-record exited early (code {proc.returncode}): {stderr.decode().strip()}")
    except subprocess.TimeoutExpired:
        pass

    # Ask pw-record to stop cleanly so it finalizes the WAV header, then wait briefly.
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        die("pw-record did not exit after SIGINT and had to be killed; output may be corrupt.")


def record_alsa(output, duration, rate, channels, device):
    cmd = ["arecord", "-f", "S16_LE", "-r", str(rate), "-c", str(channels), "-d", str(int(math.ceil(duration)))]
    if device:
        cmd += ["-D", device]
    cmd.append(output)

    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        die("arecord not found on PATH. Install alsa-utils or use --backend pipewire.")

    if result.returncode != 0:
        die(f"arecord failed (code {result.returncode}): {result.stderr.decode().strip()}")


def verify_output_file(output):
    path = Path(output)
    if not path.exists() or path.stat().st_size == 0:
        die(f"recording produced no output at {output}")
    try:
        with wave.open(output, "rb") as wf:
            if wf.getnframes() == 0:
                die(f"recorded WAV at {output} has zero frames")
    except wave.Error as e:
        die(f"recorded file at {output} is not a valid WAV: {e}")


def chunk_stats(output):
    """Return list of (start_sec, rms, peak) per CHUNK_SECONDS window."""
    with wave.open(output, "rb") as wf:
        rate = wf.getframerate()
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        if sampwidth != 2:
            die(f"expected 16-bit samples, got {sampwidth * 8}-bit")

        frames_per_chunk = int(rate * CHUNK_SECONDS)
        stats = []
        chunk_index = 0
        while True:
            raw = wf.readframes(frames_per_chunk)
            if not raw:
                break
            count = len(raw) // 2
            samples = struct.unpack(f"<{count}h", raw)
            # Collapse channels by simple averaging so multi-channel input still yields one RMS/peak.
            if channels > 1:
                mono = [
                    sum(samples[i : i + channels]) / channels
                    for i in range(0, len(samples) - channels + 1, channels)
                ]
            else:
                mono = samples
            if not mono:
                break
            sq_sum = sum(s * s for s in mono)
            rms = math.sqrt(sq_sum / len(mono))
            peak = max(abs(s) for s in mono)
            stats.append((chunk_index * CHUNK_SECONDS, rms, peak))
            chunk_index += 1
    return stats


def dc_offset(output):
    """Mean sample value after the startup transient. Near 0 for centered audio."""
    with wave.open(output, "rb") as wf:
        rate = wf.getframerate()
        channels = wf.getnchannels()
        skip_frames = int(rate * DC_SKIP_SECONDS)
        wf.readframes(skip_frames)
        raw = wf.readframes(wf.getnframes())
    if not raw:
        return 0.0
    samples = struct.unpack(f"<{len(raw) // 2}h", raw)
    if channels > 1:
        samples = [
            sum(samples[i : i + channels]) / channels
            for i in range(0, len(samples) - channels + 1, channels)
        ]
    return sum(samples) / len(samples) if samples else 0.0


def classify(stats, dc):
    overall_rms = math.sqrt(sum(rms * rms for _, rms, _ in stats) / len(stats))

    if abs(dc) > DC_OFFSET_THRESHOLD:
        return "dc_offset", overall_rms

    if overall_rms < SILENCE_RMS_THRESHOLD:
        return "silence", overall_rms

    # Exclude the startup transient window when judging flatness.
    steady = [rms for start, rms, _ in stats if start >= STARTUP_SKIP_SECONDS]
    if not steady:
        steady = [rms for _, rms, _ in stats]
    min_rms = min(steady) if min(steady) > 0 else 1e-9
    ratio = max(steady) / min_rms

    if ratio < FLAT_NOISE_RATIO_THRESHOLD:
        return "flat_noise", overall_rms

    return "real_signal", overall_rms


def print_report(output, stats, backend, dc):
    print(f"\n{'time':>6}  {'rms':>8}  {'peak':>6}")
    for start, rms, peak in stats:
        print(f"{start:6.1f}  {rms:8.1f}  {peak:6d}")

    verdict, overall_rms = classify(stats, dc)
    print(f"\noverall RMS: {overall_rms:.1f}   DC offset: {dc:.1f}")

    aplay_cmd = "aplay -D pipewire " + output if backend == "pipewire" else "aplay " + output

    if verdict == "dc_offset":
        print("verdict: LARGE DC OFFSET (device fault, not silence/noise)")
        print(f"  DC offset ({dc:.1f}) exceeds the threshold ({DC_OFFSET_THRESHOLD:.0f}). "
              "The capture device is delivering a fixed offset instead of centered audio, "
              "which swamps the real signal. Check that you're capturing from a DC-corrected "
              "source (see docs/superpowers/specs/environment.md) rather than the raw device.")
    elif verdict == "silence":
        print("verdict: LIKELY SILENCE")
        print(f"  overall RMS ({overall_rms:.1f}) stayed below the silence threshold "
              f"({SILENCE_RMS_THRESHOLD:.0f}) for the whole clip.")
    elif verdict == "flat_noise":
        print("verdict: LIKELY FLAT NOISE (not speech)")
        print("  RMS barely varies between chunks; real speech has pauses and dynamic range. "
              "This looks like a constant tone/hum rather than a voice.")
    else:
        print("verdict: LIKELY REAL SIGNAL CAPTURED")
        print("  RMS varies meaningfully across chunks (quiet and loud parts), consistent with "
              "speech or room audio.")

    print(f"\nConfirm by ear: {aplay_cmd}")


def main():
    args = parse_args()
    if args.duration <= 0:
        die("--duration must be positive")
    if args.rate <= 0:
        die("--rate must be positive")
    if args.channels <= 0:
        die("--channels must be positive")

    print(f"Recording {args.duration:.1f}s via {args.backend} to {args.output} "
          f"({args.rate} Hz, {args.channels}ch)...")

    if args.backend == "pipewire":
        record_pipewire(args.output, args.duration, args.rate, args.channels, args.device)
    else:
        record_alsa(args.output, args.duration, args.rate, args.channels, args.device)

    verify_output_file(args.output)

    stats = chunk_stats(args.output)
    if not stats:
        die(f"no audio chunks decoded from {args.output}")

    print_report(args.output, stats, args.backend, dc_offset(args.output))


if __name__ == "__main__":
    main()
