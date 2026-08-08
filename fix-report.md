# Housekeeping fixes from architecture audit

## Fix 1: Drop unused `meeting-notes-core` dependency

**Found:** `crates/meeting-notes-audio/Cargo.toml` declared `meeting-notes-core = { path = "../meeting-notes-core" }`.
Confirmed via `grep -rn "meeting_notes_core" crates/meeting-notes-audio/src/` that nothing in the crate's source
references it (zero matches).

**Changed:** Removed the dependency line from `crates/meeting-notes-audio/Cargo.toml`.

**Verified:** `cargo build` (workspace) compiles cleanly with the dependency removed; `Cargo.lock` updated
accordingly (single line removed from `meeting-notes-audio`'s dependency list, no other changes). `cargo test
--workspace` passes.

## Fix 2: Resolve the `mod macos;` latent build break

**Found:** `crates/meeting-notes-audio/src/lib.rs` had `#[cfg(target_os = "macos")] mod macos; #[cfg(target_os =
"macos")] pub use macos::RecordingHandle;`, but `ls crates/meeting-notes-audio/src/` confirmed there is no
`macos.rs` file (only `lib.rs`, `linux.rs`, `linux/`, `mic_watcher.rs`, `mic_watcher_tests.rs`, `tests.rs`). The
sibling `#[cfg(target_os = "linux")] mod linux;` block does have a real `linux.rs` and was left untouched.

**Changed:**
- Removed the dead `#[cfg(target_os = "macos")] mod macos;` / `pub use macos::RecordingHandle;` lines entirely.
- Changed `#[cfg(not(any(target_os = "linux", target_os = "macos")))] compile_error!("meeting-notes-audio
  currently supports Linux and macOS only");` to `#[cfg(not(target_os = "linux"))] compile_error!("meeting-notes-
  audio currently supports Linux only");`.
- Also fixed a stray reference to `macos.rs` in a doc comment on `recover_interrupted_recording` (it described the
  `<stem>.mic.wav`/`<stem>.system.wav` convention as "see `linux.rs`/`macos.rs`" -- now just `linux.rs`), found
  while reading the file for the compile_error edit.

**Verified:** `cargo build`/`cargo test --workspace` pass (project only ever targets Linux, so this branch was
already never compiled; the fix removes the dead code and correspondingly the false promise of macOS support, it
doesn't change any compiled behavior on Linux).

## Fix 3: Narrow or remove the `opener:default` capability

**Found:**
- `src-tauri/capabilities/default.json` granted `"opener:default"`. Checked the actual plugin (`tauri-plugin-
  opener` 2.5.4, installed at `~/.cargo/registry/.../tauri-plugin-opener-2.5.4/permissions/default.toml`): its
  `default` permission set is `allow-open-url`, `allow-reveal-item-in-dir`, `allow-default-urls` (notably it does
  *not* even include `allow-open-path`).
- `grep -rn "opener"` / `"plugin-opener"` across `src/` found no frontend usage of the opener plugin's JS API or
  any `invoke("plugin:opener|...")` call. `@tauri-apps/plugin-opener` is present in `package.json` (npm dep) but
  never imported anywhere in `src/`.
- `src-tauri/src/commands/storage_commands.rs` (`open_summary`) and `src-tauri/src/commands/history_commands.rs`
  (`reveal_in_file_manager`) both call `tauri_plugin_opener::OpenerExt`'s `app.opener().open_path(...)` directly
  from Rust. Their own doc comments explain this is deliberate: the plugin's own IPC command's ACL scope is static
  and can't be widened at runtime to "wherever the user's configured data directory happens to be", so these
  commands sidestep the capability system entirely and do their own path validation instead (meeting-id
  sanitization / index lookup).

Conclusion: nothing in this app goes through the opener plugin's capability-gated IPC path, in either direction --
the frontend never calls it, and the two Rust commands that use the plugin bypass the capability system on
purpose. `"opener:default"` was dead configuration.

**Changed:** Removed `"opener:default"` from `src-tauri/capabilities/default.json`'s permissions array.

**Verified:**
- `cargo build` (from `src-tauri/`) compiles cleanly with the permission removed.
- To specifically exercise Tauri's build-time capability/permission-schema validation (not just a cached build), I
  touched `capabilities/default.json` and rebuilt: `cargo build` recompiled `meeting-notes` from scratch and
  finished cleanly with no errors or warnings, confirming the capabilities file (without `opener:default`) still
  validates against the generated schema.
- `bun run build` (tsc + vite) also passes cleanly.
- **What I could NOT fully verify:** a real `bun run tauri dev` / running the app end-to-end and clicking "Open
  summary" / "Reveal in file manager" to confirm they still work at runtime -- this sandbox has no display server.
  I started `bun run tauri build --debug` as a closer approximation (it goes through the same capability-schema
  codegen as `cargo build` plus asset bundling) but it did not finish within available time; the `cargo build`
  from-scratch recompilation after touching the capabilities file is the strongest verification available here,
  and per the reasoning above (frontend never calls the plugin's IPC surface; the two Rust commands bypass
  capabilities entirely) I'm confident in the removal, but flagging the gap as requested.

## Fix 4: Delete a stale "Done state" comment

**Found:** `src/hooks/useAutoResizeWindow.ts` had several comments referencing a "Done state" / Tabs-based
overflow-y-auto content that no longer exists. Confirmed via `git show 8bba0e9 --stat` that commit removed the
in-app Done screen (action-item checklist, transcript tab, Tabs component) entirely -- summarization now opens
`summary.md` externally and returns straight to Idle. `WidgetState` is `"idle" | "recording" | "processing"`
(`src/components/RecorderWidget.tsx:23`). Grepping for `overflow-y-auto` across `src/` confirmed no current panel
(`RecorderWidget.tsx`, `ConfigDialog.tsx`, `MeetingHistory.tsx`) has any such element -- the entire "internal
scroll takes over past the cap" mechanism the comments described is gone, not just the "Done" name. I traced the
real current equivalent: `App.tsx` wraps each panel in a `flex-1 overflow-hidden` div (`src/App.tsx:370` and the
sibling wrapper around `RecorderWidget`), and panels like `MeetingHistory.tsx` are `h-full` with no internal
scroll region of their own -- so content past the cap is now simply clipped by that outer wrapper, not handed off
to an internal scrollbar.

**Changed:** Rewrote all five stale spots in `src/hooks/useAutoResizeWindow.ts` (not just line ~155) to describe
the actual current mechanism instead of the removed Done/Tabs one:
- Top-of-file comment: replaced "the internal overflow-y-auto panels in RecorderWidget.tsx's Done-state Tabs
  content take over instead" with an accurate description (no internal scroll fallback exists; content past the
  cap is clipped by App.tsx's `overflow-hidden` wrapper), and swapped the "long meeting summary/transcript" example
  for "a long meeting history list" (History's own 600px cap is a live example, referenced from App.tsx).
- `remeasureKey` doc comment: replaced "(Done -> Idle via \"New Recording\")" with "(e.g. closing ConfigDialog or
  History back to the plain Idle screen)".
- `measure()`'s Idle/Done comment: dropped "/Done" (state leaves Idle for the pill, not "Idle/Done").
  scrollHeight-pin comment: replaced the described chain ("RecorderWidget's h-full Done root -> Tabs' flex-1
  overflow-hidden -> each TabsContent's overflow-y-auto flex-1") with the real current chain (App.tsx's `flex-1
  overflow-hidden` wrapper around either panel's own `h-full` root).
- `el.style.height` write comment: replaced "lets RecorderWidget.tsx's already-present overflow-y-auto Tabs
  content actually activate" with the real current purpose (keeps `el`'s box height in lockstep with the OS window
  size so clipping by the outer wrapper stays visually in sync with the resize animation).
- Cleanup-on-teardown comment (the one at line ~155 originally called out): replaced "a height forced by a capped
  Done state" with "a height forced by a capped Idle-state panel (e.g. a long Meeting History list)" -- the
  underlying logic (resetting `el.style.height` so it doesn't fight the pill's `h-screen w-screen` sizing) is
  still real and still needed, so I kept the comment, just fixed the terminology and example.

I stayed within this one file (didn't touch `App.tsx`, which also has a couple of stale "Done"-state comments) --
that's outside this fix's declared scope and not in the commit's file list.

**Verified:** No test coverage exists for hook internals/comments (this hook has no `.test.ts`); verified via `bun
run build` (tsc typecheck passes -- comments don't affect typechecking, but this confirms the file still parses
and the surrounding code wasn't accidentally broken) and by re-reading the full file after editing to confirm
sentence flow across each edited comment block.

## Fix 5: Debounce `MeetingHistory`'s `onContentChange`

**Found:** `src/components/MeetingHistory.tsx` had:
```ts
useEffect(() => {
  onContentChange?.();
}, [entries, page, search, typeFilter, statusFilter, dateFilter, onContentChange]);
```
`search` changes on every keystroke (`onChange` on the search `<Input>`), so this fired on every keystroke.
Traced `onContentChange` to `App.tsx`'s `handleHistoryContentChange`, which bumps `historyContentVersion`, which
feeds `useAutoResizeWindow`'s `remeasureKey` -- each firing triggers `measure()`, which does `await
currentMonitor()` and `await currentWindowSize()` (both real Tauri IPC calls) and an animated resize. Confirmed via
`grep` there's no existing debounce utility anywhere in the codebase.

**Changed:**
- Added a `CONTENT_CHANGE_DEBOUNCE_MS = 200` constant near the existing `PAGE_SIZE`/`UNDO_WINDOW_MS` constants.
- Added a `contentChangeTimerRef` (`useRef<ReturnType<typeof setTimeout> | null>`).
- Rewrote the effect to clear any pending timer, schedule a new `setTimeout(() => onContentChange?.(),
  CONTENT_CHANGE_DEBOUNCE_MS)`, and clear it in the effect's cleanup (covers both re-runs and unmount) -- standard
  `useRef` + `setTimeout` debounce, no new dependency.

**Tests:** `src/components/MeetingHistory.test.tsx` already had a `describe("onContentChange", ...)` block with 4
tests asserting the callback fires on load/pagination/search/re-run. Updated all four to `await waitFor(() =>
expect(...))` instead of asserting immediately after the triggering `await`, since the call is now delayed by
~200ms (these tests use real timers; `waitFor`'s default 1000ms timeout comfortably covers the debounce window).
Added a fifth test, `"coalesces rapid successive keystrokes into a single debounced call"`, using
`vi.useFakeTimers({ shouldAdvanceTime: true })` + `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`
(the same pattern already used in the file's `Date filter`/`Delete` describe blocks) to type a 5-character search
string and assert `onContentChange` is called zero additional times immediately after typing, then exactly once
after advancing timers past the debounce window.

**Verified:** `bun run test --run` -- all 204 tests pass (15 test files), including the 5 updated/added
`onContentChange` tests in `MeetingHistory.test.tsx`. `bun run build` passes.

## Overall verification

- `cd src-tauri && cargo build` -- clean, no warnings/errors.
- `cd src-tauri && cargo test --workspace` -- all tests pass (55 in the largest suite, others all green; 3 tests
  marked `ignored` pre-existing and unrelated to this change).
- `bun run test --run` -- 204/204 tests pass across 15 files.
- `bun run build` (tsc + vite) -- clean build, no type errors.
- `bun run tauri build --debug` -- started as an extra check for Fix 3 but did not finish in the available time in
  this sandbox (no display server here regardless, so a full runtime click-test of Open Summary / Reveal in File
  Manager was never going to be possible either way). The `cargo build` capability-schema validation (re-run after
  touching `capabilities/default.json`) is the verification actually relied on for Fix 3.
