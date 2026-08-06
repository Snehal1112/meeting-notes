# Release Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give meeting-notes the same release infrastructure as the sibling
`rocket` project — a local version-bump/changelog tool, three GitHub
Actions workflows, and Tauri's signed-updater packaging — adapted for bun
and scoped to Linux-only (the only target that currently compiles).

**Architecture:** `release-it` (+ `@release-it/conventional-changelog`)
handles local version bump + `CHANGELOG.md` + git tag; a `after:bump` hook
syncs the new version into `tauri.conf.json`. Three GitHub Actions
workflows (`pr-check.yml`, `build.yml`, `release.yml`) reuse the same
Rust+bun setup steps; `release.yml` additionally uses `git-cliff` to
generate the GitHub Release body and `tauri-apps/tauri-action@v0` to build,
sign (via the Tauri updater plugin's keypair), and publish a draft release
with `.deb`/`.rpm`/`.AppImage` bundles plus a signed `latest.json` updater
manifest.

**Tech Stack:** `release-it`, `@release-it/conventional-changelog`,
`git-cliff`, GitHub Actions (`dtolnay/rust-toolchain`, `swatinem/rust-cache`,
`oven-sh/setup-bun`, `orhun/git-cliff-action`, `tauri-apps/tauri-action`,
`actions/upload-artifact`), `tauri-plugin-updater` (Rust).

## Global Constraints

- Comments end with a punctuation mark and use short, plain sentences.
- For any task that touches Rust or TypeScript source (Task 2): code must
  build (`cargo check`, `bun run build`) and the full test suites
  (`cargo test --workspace`, `bunx vitest run`) must still pass before
  commit. Tasks that touch only config/YAML (Tasks 1, 3, 4) verify via the
  tool-specific checks their own steps already specify (dry-run, YAML
  parse) rather than re-running unrelated suites.
- Linux-only (`x86_64-unknown-linux-gnu`, `ubuntu-22.04` in CI) — no
  macOS/Windows matrix entries. `crates/meeting-notes-audio` currently
  `compile_error!`s on anything but Linux/macOS, and its `macos` module
  doesn't exist yet, so only Linux compiles today.
- No in-app "check for updates" UI/code, and no `@tauri-apps/plugin-updater`
  JS dependency or `updater:*` capability grant — this mirrors rocket's own
  scope exactly (verified rocket has none of that either). The updater
  work in this plan is packaging plumbing only.
- The Tauri signing private key and its password are never committed to
  the repo and never pushed to GitHub as secrets by the implementer — they
  are generated locally, reported to the user, and the user adds the
  GitHub repo secrets themselves.

---

### Task 1: Local version-bump tooling (release-it + git-cliff)

**Files:**
- Create: `.release-it.json`
- Create: `scripts/sync-tauri-version.cjs`
- Create: `cliff.toml`
- Create: `CHANGELOG.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `bun run release` / `release:patch` / `release:minor` /
  `release:major` scripts — consumed by the user when cutting a release
  (not by any later task). Produces `cliff.toml` at the repo root — Task 4's
  `release.yml` references this exact path.

- [ ] **Step 1: Add release-it and its changelog plugin**

Run: `bun add -D release-it @release-it/conventional-changelog`

- [ ] **Step 2: Verify the devDependencies landed**

Run: `grep -A3 '"devDependencies"' package.json | head -5`
Expected: `release-it` and `@release-it/conventional-changelog` both appear
somewhere in the `devDependencies` block (order doesn't matter — `bun add`
inserts alphabetically among existing entries).

- [ ] **Step 3: Create the version-sync script**

Create `scripts/sync-tauri-version.cjs`:

```js
// Reads the version from package.json and writes it to tauri.conf.json.
// Run automatically via release-it's after:bump hook.
const fs = require("fs");
const path = require("path");

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
const tauriConfPath = path.resolve(__dirname, "../src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = pkg.version;
fs.writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`);
```

- [ ] **Step 4: Smoke-test the sync script against a temporary version bump**

Manually edit `package.json`'s `"version"` field from `"0.1.0"` to
`"0.1.0-synctest"`, then run:

Run: `node scripts/sync-tauri-version.cjs`
Expected: no error.

Run: `grep '"version"' src-tauri/tauri.conf.json`
Expected: `"version": "0.1.0-synctest"` (was `"0.1.0"` before).

Then revert both files back to `"0.1.0"` — edit `package.json`'s version
back to `"0.1.0"` and either re-run the script (it will write `"0.1.0"`
back into `tauri.conf.json`) or edit `tauri.conf.json`'s version back
directly. Confirm with:

Run: `git diff package.json src-tauri/tauri.conf.json`
Expected: no output (both files match their committed state — the
smoke test left no trace).

- [ ] **Step 5: Create the release-it config**

Create `.release-it.json`:

```json
{
  "git": {
    "commitMessage": "chore(release): v${version}",
    "tagName": "v${version}",
    "requireCleanWorkingDir": false
  },
  "github": {
    "release": false
  },
  "hooks": {
    "after:bump": "node scripts/sync-tauri-version.cjs"
  },
  "plugins": {
    "@release-it/conventional-changelog": {
      "preset": "conventionalcommits",
      "infile": "CHANGELOG.md"
    }
  }
}
```

`"github": {"release": false}` is deliberate: `release-it` only bumps,
changelogs, commits, and tags locally. The GitHub Release (with binaries
attached) is created by `release.yml` (Task 4) when the tag is pushed.

- [ ] **Step 6: Add the release scripts to package.json**

In `package.json`'s `"scripts"` block, add:

```json
"release": "release-it",
"release:patch": "release-it patch",
"release:minor": "release-it minor",
"release:major": "release-it major"
```

- [ ] **Step 7: Create an empty changelog**

Create `CHANGELOG.md`:

```markdown
# Changelog

All notable changes to this project will be documented in this file. See
[Conventional Commits](https://www.conventionalcommits.org/) for commit
guidelines.
```

- [ ] **Step 8: Dry-run release-it end to end**

Run: `bunx release-it patch --dry-run --ci`

An explicit `patch` argument is used here (rather than letting release-it
infer a bump from conventional commits) so the expected version is
deterministic — this repo's history has many `feat:` commits, which
conventional-commits semantics would otherwise recommend a `minor` bump
for.

Expected: exits 0, prints a plan that includes bumping to `0.1.1`, running
the `after:bump` hook, and writing `CHANGELOG.md` — but makes no actual
changes (dry-run). Confirm with `git status --short` that nothing changed.

- [ ] **Step 9: Create the git-cliff config**

Create `cliff.toml`:

```toml
[changelog]
header = ""
body = """
{% for group, commits in commits | group_by(attribute="group") %}
### {{ group }}
{% for commit in commits %}
- {% if commit.scope %}**{{ commit.scope }}:** {% endif %}{{ commit.message }}\
{% endfor %}
{% endfor %}
"""
trim = true

[git]
conventional_commits = true
filter_unconventional = true
split_commits = false

commit_parsers = [
  { message = "^feat", group = "Features" },
  { message = "^fix", group = "Bug Fixes" },
  { message = "^perf", group = "Performance" },
  { message = "^refactor", group = "Refactoring" },
  { message = "^doc", group = "Documentation" },
  { message = "^test", skip = true },
  { message = "^chore", skip = true },
  { message = "^revert", skip = true },
  { message = "^ci", skip = true },
  { message = "^style", skip = true },
]

filter_commits = true
tag_pattern = "v[0-9].*"
skip_tags = ""
ignore_tags = ""
topo_order = false
sort_commits = "oldest"
```

- [ ] **Step 10: Verify git-cliff parses the config and the real commit log**

Run: `git-cliff --config cliff.toml --unreleased --strip header`
Expected: exits 0, prints a grouped changelog body (`### Features`,
`### Bug Fixes`, etc.) built from this repo's actual commits since the last
`v*` tag — there are no `v*` tags yet, so this covers the whole history and
should produce non-empty output, confirming the parser config and the
conventional-commit-style messages already used in this repo's history
(`feat:`, `fix:`, `docs:`, `chore:`) are compatible.

- [ ] **Step 11: Commit**

```bash
git add .release-it.json scripts/sync-tauri-version.cjs cliff.toml CHANGELOG.md package.json bun.lock
git commit -m "chore: add release-it + git-cliff versioning and changelog tooling"
```

---

### Task 2: Tauri updater plugin wiring + signing keypair

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: a signing keypair at `~/.tauri/meeting-notes.key` (outside the
  repo, never committed) plus a password — both are printed at the end of
  this task for the user to add as GitHub repo secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
  Produces the public key embedded in `tauri.conf.json`'s
  `plugins.updater.pubkey` — Task 4's `release.yml` relies on the secret
  names above existing in the GitHub repo for its signing step to succeed
  (the workflow itself doesn't need anything from this task beyond that —
  it's set up regardless in Task 4, and will simply fail to sign until the
  secrets are added).

- [ ] **Step 1: Add the updater plugin dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-updater = "2"
```

- [ ] **Step 2: Register the plugin**

In `src-tauri/src/lib.rs`, the current `Builder` chain starts:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RecordingState(Mutex::new(None)))
```

Add the updater plugin registration:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RecordingState(Mutex::new(None)))
```

(Read the real current file first — this plan's plans/specs directory has
a documented history of "current file" snippets going stale between
sessions; confirm the exact surrounding lines before editing.)

- [ ] **Step 3: Generate the signing keypair**

Run:
```bash
mkdir -p ~/.tauri
SIGNING_PASSWORD=$(openssl rand -base64 24)
bunx tauri signer generate -w ~/.tauri/meeting-notes.key --ci -p "$SIGNING_PASSWORD"
echo "Password (save this now, it will not be shown again): $SIGNING_PASSWORD"
```
Expected: prints a public key (a long base64-looking string starting with
`untrusted comment:` on the line above it) and writes the private key file
to `~/.tauri/meeting-notes.key`. Copy the printed public key for the next
step. Keep the printed password — it and the private key file's contents
are what get reported to the user at the end of this task.

- [ ] **Step 4: Add the updater plugin config**

In `src-tauri/tauri.conf.json`, add a top-level `"plugins"` key (add it as
a sibling of `"app"` and `"bundle"`) using the public key from Step 3:

```json
"plugins": {
  "updater": {
    "pubkey": "<public key printed in Step 3>",
    "endpoints": [
      "https://github.com/Snehal1112/meeting-notes/releases/latest/download/latest.json"
    ]
  }
}
```

Also add `"createUpdaterArtifacts": false` inside the existing `"bundle"`
object, alongside `"active"`/`"targets"`/`"icon"` — this documents the
default explicitly (matching rocket's own base config) rather than relying
on an implicit default; only the release workflow's `--config` override
turns it on.

- [ ] **Step 5: Verify the Rust side builds and tests still pass**

Run: `cd src-tauri && cargo check`
Expected: builds cleanly, no errors (this also validates the new
`tauri.conf.json` structure against Tauri's config schema).

Run: `cargo test --workspace`
Expected: all tests pass, same counts as before this task (no test changes
in this task).

- [ ] **Step 6: Verify the frontend build is unaffected**

Run: `cd .. && bun run build`
Expected: builds cleanly (this task makes no frontend changes, but
`tauri.conf.json` is read during the Tauri build step of `bun run tauri
build`, not `bun run build` alone — this step just confirms nothing broke
the plain frontend build).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat: wire up Tauri updater plugin for signed release artifacts"
```

- [ ] **Step 8: Report the signing key material to the user**

Print, in the task's final report (not committed anywhere):
- The full contents of `~/.tauri/meeting-notes.key`
  (`cat ~/.tauri/meeting-notes.key`) — this is the value for the
  `TAURI_SIGNING_PRIVATE_KEY` GitHub secret.
- The password generated in Step 3 — this is the value for the
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secret.
- A reminder that these two secrets must be added under the
  `Snehal1112/meeting-notes` GitHub repo's Settings → Secrets and
  variables → Actions before any tag push will successfully produce
  signed updater artifacts. Both secrets are a hard prerequisite for
  `release.yml` to produce any artifacts at all: with
  `plugins.updater.pubkey` set and `createUpdaterArtifacts: true` (which
  `release.yml` forces via its `--config` override), a missing
  `TAURI_SIGNING_PRIVATE_KEY` aborts the entire bundle step, producing zero
  artifacts. Adding only `TAURI_SIGNING_PRIVATE_KEY` without
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is worse: the Tauri CLI prompts for a
  password on stdin and the CI job hangs until the runner timeout instead of
  failing fast. Add both secrets together, never just one.

---

### Task 3: PR-check and main-branch build workflows

**Files:**
- Create: `.github/workflows/pr-check.yml`
- Create: `.github/workflows/build.yml`

**Interfaces:**
- None consumed from earlier tasks (these two workflows don't reference
  `cliff.toml`, the release-it scripts, or the signing secrets at all).
- Produces: the "shared setup steps" pattern (system deps, Rust toolchain,
  rust-cache, bun) that Task 4's `release.yml` repeats — not a shared file,
  just a pattern to follow, since none of these three workflows factor out
  a composite action.

- [ ] **Step 1: Create the PR-check workflow**

Create `.github/workflows/pr-check.yml`:

```yaml
name: PR Check

on:
  pull_request:
    branches: [main]

concurrency:
  group: pr-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-22.04

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: . -> target

      - name: Install Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Setup bun
        uses: oven-sh/setup-bun@v2

      - name: Install frontend dependencies
        run: bun install --frozen-lockfile

      - name: TypeScript check
        run: bunx tsc --noEmit

      - name: Rust check
        run: cargo check --manifest-path src-tauri/Cargo.toml

      - name: Frontend build
        run: bun run build

      - name: Tauri build
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Validate the workflow YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pr-check.yml'))" && echo VALID`
Expected: prints `VALID`, no exception.

- [ ] **Step 3: Create the main-branch build workflow**

Create `.github/workflows/build.yml`:

```yaml
name: Build

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: build-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-22.04

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: . -> target

      - name: Install Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Setup bun
        uses: oven-sh/setup-bun@v2

      - name: Install frontend dependencies
        run: bun install --frozen-lockfile

      - name: Build with Tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: meeting-notes-x86_64-unknown-linux-gnu
          path: |
            target/release/bundle/**/*.deb
            target/release/bundle/**/*.rpm
            target/release/bundle/**/*.AppImage
          retention-days: 30
          if-no-files-found: warn
```

- [ ] **Step 4: Validate the workflow YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml'))" && echo VALID`
Expected: prints `VALID`, no exception.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pr-check.yml .github/workflows/build.yml
git commit -m "ci: add PR-check and main-branch build workflows"
```

---

### Task 4: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `cliff.toml` from Task 1 (referenced by path). Consumes the
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret
  names from Task 2 (the workflow references
  `${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}` etc. — these must be added to
  the GitHub repo by the user per Task 2's Step 8 before a real tag push
  will produce signed artifacts). Follows the same setup-step pattern
  established in Task 3.

- [ ] **Step 1: Create the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  changelog:
    runs-on: ubuntu-22.04
    outputs:
      body: ${{ steps.cliff.outputs.content }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Generate changelog
        uses: orhun/git-cliff-action@v4
        id: cliff
        with:
          config: cliff.toml
          args: --latest --strip header

  release:
    needs: changelog
    runs-on: ubuntu-22.04

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: . -> target

      - name: Install Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Setup bun
        uses: oven-sh/setup-bun@v2

      - name: Install frontend dependencies
        run: bun install --frozen-lockfile

      - name: Build and release with Tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Meeting Notes ${{ github.ref_name }}'
          releaseBody: ${{ needs.changelog.outputs.body }}
          releaseDraft: true
          prerelease: false
          args: --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

No `matrix`/`strategy` block and no `--target` flag: this runs natively on
the `ubuntu-22.04` runner's own host target, which is
`x86_64-unknown-linux-gnu` — the only target that compiles today (see
Global Constraints). No `updaterJsonPreferNsis` (that flag only affects
Windows NSIS installer metadata, not applicable here).

- [ ] **Step 2: Validate the workflow YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo VALID`
Expected: prints `VALID`, no exception.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered release workflow with signed updater artifacts"
```

- [ ] **Step 4: Report the remaining manual steps to the user**

In the task's final report, remind the user (this is not something to do
automatically):
- Add the two signing secrets from Task 2's Step 8 to the GitHub repo, if
  not already done.
- The first real exercise of this workflow should be an actual release:
  `bun run release:patch`, review the resulting commit/tag locally, then
  `git push --follow-tags` to trigger it — recommended as the concrete
  end-to-end verification this plan's design doc calls for, since GitHub
  Actions workflows can't be fully verified by static analysis alone.
