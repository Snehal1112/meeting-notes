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

**Mic capture: BROKEN on this machine — confirmed, not a config issue.**

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
- **Action needed before Plan 04 can rely on mic capture on this machine:**
  either fix the AMD DMIC driver/firmware setup (needs further hardware-
  specific research and likely sudo), or use an external USB mic as a
  workaround. Plan 04 should not assume this "just works" from the design
  spec's description.

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
