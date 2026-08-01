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
