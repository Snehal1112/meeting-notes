# Release Packaging Setup Design

**Goal:** Give meeting-notes the same release infrastructure as the sibling
`rocket` project (Tauri v2 + Rust workspace + React/TS, same shape, Yarn
instead of bun) — a local version-bump/changelog tool, three GitHub Actions
workflows, and Tauri's signed-updater packaging — adapted for bun and
scoped to what this project actually supports today.

**Reference:** `/home/numericlabs/data/rocket/rocket`'s `.release-it.json`,
`scripts/sync-tauri-version.cjs`, `cliff.toml`, and
`.github/workflows/{pr-check,build,release}.yml`.

**Explicitly out of scope:**
- macOS/Windows builds. `crates/meeting-notes-audio` currently
  `compile_error!`s on anything but Linux/macOS, and its `macos` module is
  `#[cfg]`-declared but the file doesn't exist — so only
  `x86_64-unknown-linux-gnu` actually compiles right now. Matches
  `CLAUDE.md`'s existing "Linux-only for now" scope. Adding another
  platform later is additive (new matrix entries), not a redesign of this
  work.
- In-app "check for updates" UI/logic. Verified rocket itself doesn't have
  this either — its updater setup is packaging-only: the Rust plugin is
  registered and `tauri.conf.json` has the pubkey/endpoint, but there's no
  `@tauri-apps/plugin-updater` JS dependency, no `updater:*` capability
  grant, and no frontend code calling `check()`. This design matches that
  scope exactly, not a more complete implementation.
- The `.github/scripts/bump-version.sh` / `.version-bump.json`
  drift-checker pattern seen in rocket — confirmed dead/unused there (the
  config file it needs was never committed, nothing references the
  script). Not a live pattern worth copying.
- Automatically publishing the drafted GitHub Release, or pushing
  `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` to GitHub secrets on the user's
  behalf — both stay manual by explicit choice (see §4).

## 1. Local version-bump tooling

New root files:

- **`.release-it.json`** — same shape as rocket's:
  ```json
  {
    "git": {
      "commitMessage": "chore(release): v${version}",
      "tagName": "v${version}",
      "requireCleanWorkingDir": false
    },
    "github": { "release": false },
    "hooks": { "after:bump": "node scripts/sync-tauri-version.cjs" },
    "plugins": {
      "@release-it/conventional-changelog": {
        "preset": "conventionalcommits",
        "infile": "CHANGELOG.md"
      }
    }
  }
  ```
  `"github": {"release": false}` is deliberate: `release-it` only bumps,
  changelogs, commits, and tags locally. Creating the GitHub Release
  (draft, with binaries attached) is the release workflow's job, triggered
  by pushing the tag (`git push --follow-tags`).

- **`scripts/sync-tauri-version.cjs`** — verbatim port of rocket's version:
  reads `version` from `package.json`, writes it into
  `src-tauri/tauri.conf.json`'s `version` field, preserving 2-space JSON
  formatting plus a trailing newline. Pure Node `fs`/`path`, no bun-specific
  changes needed since `release-it` invokes it via plain `node`.

- **`cliff.toml`** — git-cliff config for the GitHub Release body text
  (separate from the committed `CHANGELOG.md`, which conventional-changelog
  produces). Same template/grouping as rocket (Features, Bug Fixes,
  Performance, Refactoring, Documentation; skips test/chore/revert/ci/style
  commits), `conventional_commits = true`, `tag_pattern = "v[0-9].*"`.

- **`package.json`**: add `release-it` + `@release-it/conventional-changelog`
  as devDependencies (`bun add -D`), and scripts:
  ```json
  "release": "release-it",
  "release:patch": "release-it patch",
  "release:minor": "release-it minor",
  "release:major": "release-it major"
  ```

- **`CHANGELOG.md`**: new file at repo root, created empty (or with a
  minimal header) — `release-it`'s conventional-changelog plugin prepends
  to it on the first real release.

- **Cargo workspace version stays decoupled**, same as rocket: the root
  `Cargo.toml` is a virtual workspace manifest (no `[package]`/version of
  its own); `src-tauri/Cargo.toml`'s `version` field stays at whatever it
  is and is *not* synced from `package.json`. Only `tauri.conf.json`'s
  version is kept in sync, via the hook above.

## 2. GitHub Actions workflows

All three are Linux-only (`ubuntu-22.04`), single target
(`x86_64-unknown-linux-gnu`) — no matrix, since that's the only target that
compiles today.

**Shared setup steps** (repeated in all three, following rocket's pattern
of not factoring out a composite action):
1. Checkout
2. `apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
3. `dtolnay/rust-toolchain@stable`
4. `swatinem/rust-cache@v2` with `workspaces: ". -> target"` — meeting-notes'
   `Cargo.toml` workspace lives at the repo root (verified: `target/` and
   `target/release/bundle/**` land at the repo root, not
   `src-tauri/target`), unlike rocket's `src-tauri -> target` mapping.
5. `oven-sh/setup-bun@v2`
6. `bun install --frozen-lockfile`

### `.github/workflows/pr-check.yml`
Trigger: `pull_request: branches: [main]`, concurrency cancel-in-progress
per branch. One job: shared setup, then `bunx tsc --noEmit`,
`cargo check --manifest-path src-tauri/Cargo.toml`, `bun run build`, then a
full `tauri-apps/tauri-action@v0` build (no release fields) as an
end-to-end compile check, same as rocket's PR gate.

### `.github/workflows/build.yml`
Trigger: `push: branches: [main]` + `workflow_dispatch`, concurrency
cancel-in-progress per branch. Shared setup, `tauri-apps/tauri-action@v0`
(build only), then `actions/upload-artifact@v4` named
`meeting-notes-x86_64-unknown-linux-gnu` globbing
`target/release/bundle/**/*.{deb,rpm,AppImage}`, 30-day
retention, `if-no-files-found: warn`.

### `.github/workflows/release.yml`
Trigger: `push: tags: ['v*']`.

- **Job `changelog`**: checkout with `fetch-depth: 0`,
  `orhun/git-cliff-action@v4` with `config: cliff.toml`,
  `args: --latest --strip header`, exposes `outputs.body`.
- **Job `release`** (needs `changelog`): shared setup, then
  `tauri-apps/tauri-action@v0` with:
  - env: `GITHUB_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`,
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  - with: `tagName: ${{ github.ref_name }}`,
    `releaseName: 'Meeting Notes ${{ github.ref_name }}'`,
    `releaseBody: ${{ needs.changelog.outputs.body }}`,
    `releaseDraft: true`, `prerelease: false`,
    `args: --config '{"bundle":{"createUpdaterArtifacts":true}}'`

Publishes a **draft** GitHub Release with the `.deb`/`.AppImage`/`.rpm`
bundles plus signed updater artifacts (`.sig` files + `latest.json`) — a
human still reviews and publishes it manually, same as rocket.

## 3. Updater packaging (signed artifacts only — no in-app UI)

Matches rocket's actual scope exactly (verified rocket has no
in-app update-check code at all — see "Explicitly out of scope" above):

- **`src-tauri/Cargo.toml`**: add `tauri-plugin-updater = "2"`.
- **`src-tauri/src/lib.rs`**: add
  `.plugin(tauri_plugin_updater::Builder::new().build())` to the `Builder`
  chain, alongside the existing `opener`/`dialog` plugin registrations.
- **`src-tauri/tauri.conf.json`**: add
  ```json
  "plugins": {
    "updater": {
      "pubkey": "<generated public key>",
      "endpoints": [
        "https://github.com/Snehal1112/meeting-notes/releases/latest/download/latest.json"
      ]
    }
  }
  ```
  `bundle.createUpdaterArtifacts` is left unset (defaults false) in the
  base config; only the release workflow's `--config` override enables it,
  so day-to-day/PR builds never attempt (and can't fail on) signing.
- No `@tauri-apps/plugin-updater` npm dependency, no `updater:*` entry in
  `src-tauri/capabilities/default.json`, no frontend code. This is
  deliberate parity with rocket, not an oversight — the native plugin
  registration plus `tauri.conf.json` config is sufficient for CI's
  `tauri-action` to sign and publish updater artifacts; nothing in the
  running app ever calls the updater's commands.

**Signing keys**: generated via `bunx tauri signer generate` as part of
implementation. The public key goes into `tauri.conf.json` above. The
private key and its password are handed to the user to add as GitHub repo
secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
themselves — not pushed to GitHub by the implementer, and not committed
anywhere in the repo.

## 4. What the user does manually

- Add the two signing secrets to the GitHub repo
  (Settings → Secrets and variables → Actions), using the key material
  generated during implementation.
- Run `bun run release` (or `release:patch`/`minor`/`major`) locally when
  ready to cut a release, review the resulting commit/tag, then
  `git push --follow-tags` to trigger `release.yml`.
- Review and manually publish the resulting draft GitHub Release.

## 5. Testing

- `pr-check.yml` and `build.yml` are exercised naturally by opening a PR
  and merging to `main` after this work lands — no synthetic test needed
  beyond confirming the YAML is well-formed and a real run goes green.
- `release.yml` needs one real tag push to verify end-to-end (changelog
  generation, `tauri-action` build, signed-artifact upload, draft release
  creation) — recommend cutting an actual `v0.1.1` (or similar) as the
  first real exercise of this pipeline, once the secrets are in place.
- `scripts/sync-tauri-version.cjs` is simple enough to verify by running
  `bun run release:patch --dry-run` locally and inspecting the diff to
  `tauri.conf.json` before doing a real release.

## Known deviations (post-implementation)

- `package.json`'s `"overrides": {"conventional-changelog": "8.1.0"}` pins
  around a broken upstream release (`conventional-changelog@8.1.1`,
  published 2026-08-06, imports `isPrereleaseVersion` from
  `@conventional-changelog/git-client`, which `git-client@3.1.0` doesn't
  export). Safe to remove once upstream ships a fix that restores the
  export or removes the import.
