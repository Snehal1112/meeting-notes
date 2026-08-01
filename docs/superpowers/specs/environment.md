# Environment & Toolchain Verification

Recorded by running Plan 00's checks directly on the dev machine
(`numericlabs.lxd`, Ubuntu 24.04, ThinkPad P14s Gen4). This file is the source
of truth for exact binary names/paths/versions — later plans should defer to
what's recorded here over their own inline assumptions.

## Task 1: Tauri build prerequisites

| Tool | Version | Meets plan's expectation? |
|---|---|---|
| rustc | 1.94.0 (2026-03-02) | Yes (needs 1.75+) |
| cargo | 1.94.0 | Yes |
| node | v22.22.3 | Yes (needs 18+) |
| bun | 1.3.14 | Yes (needs 1.1+) |
| `bunx create-tauri-app --version` | 4.6.2, resolves cleanly | Yes — no missing-library errors |

Linux system dependencies (`libwebkit2gtk-4.1-dev`, `build-essential`, `curl`,
`wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`) were already installed on this machine — verified via `dpkg -l`
for each package, all present. `libwebkit2gtk-4.1-dev` 2.52.3 specifically
(not the older 4.0 series some Ubuntu versions ship). No `sudo apt install`
was needed on this machine; a fresh machine would still need Plan 00 Step 2
run manually since it requires an interactive sudo password.

## Task 2: PipeWire audio capture

**Tooling:** `pw-record` is present. `pactl` (from `pulseaudio-utils`) is
**not installed** and `sudo` requires a password that isn't available in this
session, so it can't be installed here. Use the native PipeWire tools instead:
`wpctl status` (device/node listing, replaces `pactl list sources short` /
`pactl info`) and `pw-cli` for lower-level node info. Plans 04/05 should not
assume `pactl` is present — either add `pulseaudio-utils` to Plan 00's apt
step, or write capture code against `wpctl`/raw PipeWire APIs directly.

**Mic capture: FIXED — see "Resolution" below. Original findings kept for
context since the root cause (DC offset, not random noise) is a useful
diagnostic pattern for anyone hitting this on similar AMD hardware.**

```bash
pw-record --channels=1 --rate=16000 /tmp/mic-test.wav &
# ...
aplay -D pipewire /tmp/mic-test.wav
```

- Default source (id 54, "Family 17h/19h HD Audio Controller Digital
  Microphone") captures a loud transient pop at t=0 (peak ~26000/32767)
  followed by a *constant* ~5000-5400 RMS noise floor for the entire
  recording — flat, no dynamics, not correlated with speech. Confirmed
  across 3 separate attempts with the user actively speaking during
  recording; user consistently reports hearing only noise, never their
  voice.
- Alternate source (id 53, "Headphones Stereo Microphone", the ALC257
  analog codec's mic input) is pure digital silence (RMS 0.0) — nothing
  physically connected to that jack.
- Ruled out: mute/volume (source 54 unmuted, vol 0.89), playback routing
  (retried explicitly via `aplay -D pipewire`, same result), missing
  firmware/UCM packages (`firmware-sof-signed`, `alsa-ucm-conf`,
  `linux-firmware` all installed), package version skew (`wireplumber`
  0.4.17-1ubuntu4.1 is already the latest candidate for this Ubuntu 24.04 +
  `pipewire` 1.0.5 combination — no apt upgrade path exists).
- One lead, not confirmed as root cause: WirePlumber logs
  `SPA handle 'api.alsa.acp.device' could not be loaded` at startup
  (`journalctl --user -u wireplumber`). `ldd` on the providing library
  (`libspa-alsa.so`, from `libspa-0.2-modules`, installed) shows no missing
  shared library dependencies, so this isn't a simple missing-package fix.
  Most likely explanation: AMD's ACP/SOF digital-mic-array (Family
  17h/19h HD Audio Controller) needs beamforming/AGC processing this
  machine's driver stack isn't applying, so `pw-record` gets a raw/noisy
  signal instead of a processed one.
**Resolution (2026-08-01, follow-up investigation):** the mic was never
actually broken — the "noise" was a large **constant DC offset**, not random
noise. Raw ALSA capture on `hw:2,0` (card 2, `acp63` — the AMD Audio
CoProcessor backing this array, never tested directly until this follow-up)
showed a fixed offset of +2250 (channel FL) and +11700 (channel FR) on a
16-bit scale, present on every recording. `snd_sof_amd_acp63` is loaded but
unused (refcount 0); the card is actually driven by the legacy
`snd_pci_ps`/PDM path, which has zero mixer controls and does no DC-blocking
— normally the SOF DSP would do this. On top of that, the mic's PipeWire
volume had drifted to 1.53, which multiplied channel FR's offset into ~99%
hard clipping — that's the loud "noise floor" and t=0 pop that was
originally captured. The `api.alsa.acp.device` SPA handle failure noted
above was a red herring; WirePlumber falls back to a working UCM path
regardless.

**Fix applied (user-space only, no sudo/reboot needed):**
1. New file `~/.config/pipewire/pipewire.conf.d/99-dmic-dcblock.conf` — a
   `libpipewire-module-filter-chain` publishing a corrected virtual source
   ("Digital Microphone (DC-blocked)") that applies an 80Hz high-pass filter
   per channel to remove the DC offset.
2. Mic volume reset from 1.53 → 1.00 (persisted in WirePlumber's
   `default-routes` state) so the raw offset isn't re-amplified upstream of
   the filter.
3. Default input source set to the new DC-blocked virtual source
   (`priority.session = 3000` was needed or WirePlumber reverts the default).

**Verified fixed:** live re-test via `scripts/test-mic-capture.py` — DC
offset dropped from ~5000+ to 0.2, RMS now varies naturally across chunks
(525–5000) instead of sitting flat, and the recording was confirmed by ear.

**Caveat for later plans:** the DC offset is upstream of the filter, so it's
still amplified by the *raw* device's volume. If anything pushes
`alsa_input.pci-0000_64_00.6.HiFi__hw_acp63__source`'s volume back above
~1.0, channel FR will clip again and the filter can't recover it — if the
noise ever returns, check `wpctl get-volume <raw Digital Microphone id>`
first. Plan 04 should capture from the default input device (now correctly
resolves to the DC-blocked source) rather than targeting a specific node by
name, and should discard the first ~500ms of every recording (startup DC
step / filter settling time). This fix is specific to this dev machine's
`~/.config/pipewire/` — a fresh machine with the same hardware would need
the same filter-chain config re-applied; it is not part of the app itself
and shouldn't be assumed present on end-user machines. Plan 04's design
should treat this class of DC-offset/clipping issue as a real failure mode
to detect and surface to the user (not just "no monitor source" /
mic-missing), since a symptom like this can otherwise look like the app
recorded successfully.

**System audio (monitor) capture: WORKS**, verified without needing a human
listener — played a synthetic 440Hz test tone through the default sink while
simultaneously recording its monitor, then confirmed the captured audio's
440Hz spectral energy was ~750,000x the level of an off-target 1000Hz control
frequency (Goertzel algorithm, since `sox`/`ffmpeg` aren't installed).

```bash
# No pactl "<sink>.monitor" source exists under plain PipeWire (that's a
# PulseAudio-compat naming convention) — capture a sink's monitor directly
# by targeting the sink's node id and setting stream.capture.sink=true:
pw-record --target 52 -P '{ stream.capture.sink=true }' \
  --channels=1 --rate=48000 /tmp/system-test.wav
```

- Default sink: id 52, "Family 17h/19h HD Audio Controller Speaker +
  Headphones" (confirmed via `wpctl status`, marked `*`).
- Plan 05's system-audio capture should target the default sink's node id
  (resolved at runtime, e.g. via `wpctl` or the PipeWire API) with
  `stream.capture.sink=true`, not a `pactl`-style `.monitor` source name.

## Task 3: whisper.cpp + LLM provider connectivity

**whisper.cpp:** built from source (`git clone --depth 1
https://github.com/ggerganov/whisper.cpp`, `cmake -B build`, `cmake --build
build --config Release`) — succeeded cleanly, no missing deps. This machine's
`cmake`/`gcc`/`git` versions (4.4.2 / 13.3.0 / 2.43.0) are all well above
minimum requirements.

- **Binary path:** `build/bin/whisper-cli` (not `main` — that name also
  exists in this build but `whisper-cli` is the current CLI entry point;
  update Plan 08's `whisper_binary_path()` default to `whisper-cli`).
- **Model:** `base.en` downloaded via `models/download-ggml-model.sh base.en`
  → saved as `models/ggml-base.en.bin` (141MB), matching Plan 08's assumed
  `format!("models/ggml-{model}.bin")` pattern exactly — no change needed
  there.
- **Transcription test:** ran `whisper-cli -m models/ggml-base.en.bin -f
  /tmp/mic-test.wav -oj -of /tmp/mic-test` (the broken mic recording from
  Task 2). Completed in <1s for a 4.7s clip. Output correctly identified
  most of the clip as `[BLANK_AUDIO]`, consistent with the known mic-noise
  issue — this incidentally further confirms the mic capture problem is real
  (whisper found no coherent speech in it either).
- **JSON shape:** matches Plan 08's `parse_whisper_json` assumption exactly
  — top-level `transcription` array, each entry has `timestamps: {from, to}`,
  `offsets: {from, to}` (milliseconds), and `text`. No parser changes needed.

**LLM provider connectivity — both confirmed reachable:**

- **Claude API:** `curl https://api.anthropic.com/v1/messages` with
  `MEETING_NOTES_CLAUDE_API_KEY` (sourced from a local file, kept out of
  shell history/logs) and model `claude-sonnet-4-6` → valid JSON response
  with `content[0].text`. Confirmed working.
- **Ollama:** already running as a systemd service (`ollama.service`,
  active) with several models already pulled locally — no need to `ollama
  pull llama3` fresh. Tested `curl http://localhost:11434/api/generate`
  with the already-available `gemma4:e2b` model → valid JSON response with
  a `response` field. Confirmed working. (Any already-pulled model works for
  this connectivity check; Plan 10 should read the configured model name
  from config rather than hardcoding `llama3`.)

_All three tasks in this plan complete. Known open item: mic capture is
broken on this specific dev machine (see Task 2) and must be resolved (fixed
driver/firmware config, or an external USB mic) before Plan 04 can be
verified end-to-end here._
