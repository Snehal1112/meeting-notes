# Environment Setup & Toolchain Verification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan MUST run before Plan 01.** Every step here is a standalone shell-level check with no Rust/React code involved — the goal is to prove each external dependency works on this exact machine before any app code depends on it.

**Goal:** Verify every external tool the app depends on (Tauri build prerequisites, PipeWire audio capture, whisper.cpp, and the chosen LLM provider) works correctly via plain shell commands, catching environment problems before they're hidden behind three layers of Rust/Tauri/React code.

**Architecture:** No app code. Pure environment verification — install/build tools, run them directly, and record exact working commands/paths/versions in a `docs/superpowers/specs/environment.md` file that later plans reference instead of guessing at binary names or flags.

**Tech Stack:** Bash, PipeWire (`pw-record`, `pactl`), whisper.cpp (built from source or prebuilt release), Ollama (optional), curl

**Why this plan exists:** The two riskiest parts of this project — PipeWire dual-stream capture and whisper.cpp invocation — are exactly the parts most likely to differ from what the plans assume (binary names, flags, model filenames, exact JSON output shape). Verifying them standalone here, and recording the exact working invocation, turns "is this an environment problem or a code problem?" (the debugging loop that kills first-launch success) into a non-issue for every later plan.

---

### Task 1: Verify Tauri build prerequisites and record versions

**Files:**
- Create: `docs/superpowers/specs/environment.md`

- [ ] **Step 1: Check Rust, Node, and bun versions**

```bash
rustc --version
cargo --version
node --version
bun --version
```

Expected: Rust 1.75+, Node 18+, bun 1.1+. If any are missing, install Rust via `rustup`, Node via `nvm` or your distro's package manager, and bun via `curl -fsSL https://bun.sh/install | bash`.

- [ ] **Step 2: Install Tauri's Linux system dependencies**

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

- [ ] **Step 3: Verify Tauri CLI prerequisites are satisfied**

```bash
bunx create-tauri-app --version 2>&1 | head -5
```

Expected: no missing-library errors. If `libwebkit2gtk-4.1` isn't found on your Ubuntu version, check `apt-cache search libwebkit2gtk` for the version your distro ships (e.g. `4.0` on older Ubuntu) and substitute it — record whichever version actually installed.

- [ ] **Step 4: Record versions**

Create `docs/superpowers/specs/environment.md` and record the exact output of steps 1–3 (Rust/Node/bun versions, which `libwebkit2gtk` version installed). This file is referenced by later plans instead of assuming versions.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/environment.md
git commit -m "chore: record verified Tauri build prerequisites"
```

---

### Task 2: Standalone audio capture smoke test (mic + system audio)

**Files:**
- Modify: `docs/superpowers/specs/environment.md`

- [ ] **Step 1: Confirm PipeWire tooling is present**

```bash
which pw-record pactl
pactl info | grep "Server Name"
```

Expected: both binaries found; server name confirms PipeWire (e.g. "PulseAudio (on PipeWire ...)"). If `pw-record` is missing: `sudo apt install pipewire-utils`. If `pactl` is missing: `sudo apt install pulseaudio-utils` (works fine against a PipeWire server via the pulse compatibility layer).

- [ ] **Step 2: Record 5 seconds of mic audio standalone and play it back**

```bash
pw-record --channels=1 --rate=16000 /tmp/mic-test.wav &
RECORD_PID=$!
sleep 5
kill -TERM $RECORD_PID
wait $RECORD_PID 2>/dev/null
aplay /tmp/mic-test.wav
```

Expected: you hear your own voice/room audio played back. **If this fails, stop here** — this is the exact command `RecordingHandle::start_mic` (plan 04) will run programmatically, so it must work standalone first. Common fixes: wrong default input device (`pactl list sources short` to see options, `pactl set-default-source <name>`), or permission issues (check your user is in the `audio` group: `groups $USER`).

- [ ] **Step 3: Find and test the monitor source for system audio**

```bash
pactl get-default-sink
SINK=$(pactl get-default-sink)
echo "Monitor source should be: ${SINK}.monitor"
pactl list sources short | grep monitor
```

Expected: the `.monitor` source for your default sink appears in the list. Play some audio (e.g. a YouTube video) and test capture:

```bash
pw-record --channels=1 --rate=16000 --target "${SINK}.monitor" /tmp/system-test.wav &
RECORD_PID=$!
sleep 5
kill -TERM $RECORD_PID
wait $RECORD_PID 2>/dev/null
aplay /tmp/system-test.wav
```

Expected: you hear the audio that was playing through your speakers. **If no monitor source is found**, this confirms the app's mic-only fallback path (plan 05) is the realistic behavior on this machine — note that in `environment.md` now rather than discovering it mid-development.

- [ ] **Step 4: Record findings**

Append to `docs/superpowers/specs/environment.md`: whether mic capture worked, whether a monitor source was found and its exact name pattern, and the exact `pw-record`/`pactl` commands that worked. Plans 04–05 should use these exact confirmed commands rather than the generic ones as written if anything differed.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/environment.md
git commit -m "chore: verify standalone PipeWire mic + system audio capture"
```

---

### Task 3: Standalone whisper.cpp + LLM provider smoke test

**Files:**
- Modify: `docs/superpowers/specs/environment.md`

- [ ] **Step 1: Build or download whisper.cpp and a model**

```bash
git clone https://github.com/ggerganov/whisper.cpp /tmp/whisper-build
cd /tmp/whisper-build
cmake -B build
cmake --build build --config Release -j$(nproc)
bash ./models/download-ggml-model.sh base.en
```

Expected: build succeeds; the CLI binary lands at `build/bin/whisper-cli` (name varies by whisper.cpp version — check `ls build/bin/`). Record the **exact binary path and exact model filename** (e.g. `models/ggml-base.en.bin`) — plan 08's `whisper_binary_path()` default and `format!("models/ggml-{model}.bin")` must match what actually got built/downloaded here, not an assumed name.

- [ ] **Step 2: Transcribe the mic-test.wav from Task 2 standalone**

```bash
cd /tmp/whisper-build
./build/bin/whisper-cli -m models/ggml-base.en.bin -f /tmp/mic-test.wav -oj -of /tmp/mic-test
cat /tmp/mic-test.json
```

Expected: valid JSON output containing a `transcription` array with `offsets`/`text` fields matching the shape plan 08's `parse_whisper_json` expects. **If the JSON shape differs** (whisper.cpp has changed its output format across versions before), record the actual shape in `environment.md` now — plan 08's parsing function must be adjusted to match reality, not the plan's assumption.

- [ ] **Step 3: Verify the chosen LLM provider is reachable**

For Claude API:
```bash
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $MEETING_NOTES_CLAUDE_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[{"role":"user","content":"Say OK"}]}'
```
Expected: a valid JSON response with `content[0].text`. A 401 means the API key is wrong; a connection error means check network/proxy.

For Ollama (if using it instead/also):
```bash
ollama serve &
ollama pull llama3
curl -s http://localhost:11434/api/generate -d '{"model":"llama3","prompt":"Say OK","stream":false}'
```
Expected: valid JSON response with a `response` field.

- [ ] **Step 4: Record whisper.cpp binary path, model filename, JSON shape, and confirmed LLM connectivity**

Finalize `docs/superpowers/specs/environment.md` with: the exact whisper.cpp binary path to bundle/reference (update plan 08's `MEETING_NOTES_WHISPER_BIN` default to match), exact model filename pattern, confirmed JSON output shape (or a note that it matched the plan's assumption), and which LLM provider(s) are confirmed reachable.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/environment.md
git commit -m "chore: verify standalone whisper.cpp transcription and LLM provider connectivity"
```
