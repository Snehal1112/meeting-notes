# System Tray Presence — Design Spec

**Date:** 2026-08-07
**Status:** Approved, ready for implementation (Plan 33)
**Plan:** `docs/superpowers/plans/2026-08-06-33-system-tray.md`
**Depends on:** The app icon (already built), Plan 25's real `TitleBar`
close button (whose behavior this explicitly does **not** change — see
below).

## 1. Goal

A system tray icon with a quick-access context menu (Show, New Recording,
Quit), so bringing the app's window to front or starting a new recording
doesn't require hunting for it among other windows or relaunching entirely.

## 2. Resolved Decision: Pure Convenience, Not a Lifecycle Change

**The tray does not change what the close button does.** An earlier draft
of this plan assumed the standard tray-resident-app convention — close
hides to tray, Quit becomes a separate explicit action — and built that in
as Task 3. That directly conflicted with a real, deliberate, recently-built
decision: `docs/superpowers/specs/2026-08-06-titlebar-close-button-design.md`
explicitly scopes the close button as *"no tray icon, no keyboard shortcut,
no hide instead of quit behavior."* That's not an oversight to fill — it's
a stated exclusion, meaning someone looked at exactly this idea and chose
not to do it.

**Resolution:** Task 3 was dropped entirely, not deferred or softened. The
close button keeps its existing behavior — it quits the app, full stop.
The tray adds value without touching anything that was already decided.

**Practical consequence worth stating plainly:** since the window can
never be hidden without the whole app quitting, the tray's "Show" menu
item isn't un-hiding anything. It's bringing an already-running,
already-visible (the window is `alwaysOnTop`) window to focus — useful if
it's drifted behind something, ended up off-screen, or the user switched
to a different virtual desktop. Worth not over-describing this as "restore
from tray" in any UI copy, since that implies a hidden state that doesn't
exist here.

## 3. Resolved Issue: GNOME Doesn't Show Tray Icons Natively

**Not a bug — a deliberate GNOME Shell decision.** Linux tray icons use
the `StatusNotifierItem`/AppIndicator protocol. GNOME Shell dropped native
support for it years ago; no extension means no tray icon anywhere,
regardless of how correct the Tauri-side code is. This affects every
Electron/Tauri app with a tray icon on GNOME, not something specific to
this project.

Since Ubuntu's default desktop has been GNOME since 17.10, and this
project's environment setup (Plan 00) targets Ubuntu without specifying a
desktop environment, **this is the most likely reason the tray icon
appears to not work at all** during development — not a code defect.

**Fix, in order of likelihood needed:**
1. Check `echo $XDG_CURRENT_DESKTOP` — if it reports `GNOME` or
   `ubuntu:GNOME`, this applies.
2. Install "AppIndicator and KStatusNotifierItem Support" (or "Tray
   Icons: Reloaded") from extensions.gnome.org.
3. **Log out and back in** — a plain app restart does not reload GNOME
   Shell extensions.

KDE Plasma, XFCE, Cinnamon, and MATE all support tray icons natively,
no extension required — this entire section only applies to GNOME.

**Process change this caused in the plan itself:** the original manual
verification step buried this as a parenthetical aside after "run the app
and check." It's now its own explicit pre-check step, run *before* the
actual manual verification — so a missing tray icon during development
gets diagnosed as an environment question first, rather than triggering
Rust debugging for a problem that isn't in the Rust code at all.

## 4. Architecture

- `TrayIconBuilder` (Tauri v2's core tray API, not a separate plugin) —
  confirm the `tauri` dependency doesn't have `default-features = false`
  disabling the `tray-icon` feature before assuming it's available.
- Tray icon asset: reuses the same `app-icon-1024.png` source built
  earlier, but tray icons render at 16-22px depending on platform — the
  full-color gradient/shadow version may read as muddy at that size. A
  simplified flat variant, separate from the main app icon, may be needed
  specifically for the tray. (This is a real, expected divergence, not a
  failure to reuse the existing asset — see the flat mockup built earlier
  in this conversation for what that simplification looks like in
  practice.)
- Menu: three items — Show (focus/bring-to-front), New Recording (focus +
  emit a `tray-new-recording` event the frontend listens for, matching
  Plan 21's hotkey ignore-if-busy reasoning: a no-op if a recording is
  already in progress), Quit (`app.exit(0)`, identical in effect to the
  title bar's existing close button — this is intentional duplication of
  an already-correct action, not a second, different quit path).

## 5. Explicit Non-Goals

- No change to close-button behavior — see §2.
- No "minimize to tray" or "hide to tray" concept anywhere in this app —
  there is no hidden state for the window to occupy.
- No tray icon on macOS/Windows in this pass — Linux-only, matching how
  most of this project's platform-specific work has been sequenced
  (Linux first, established pattern from audio capture onward).
- No custom/animated tray icon states (e.g. changing icon while
  recording) — the tray icon is static; live status is what the pill
  window itself already shows.

## 6. Testing

- **Manual only** — tray icon presence/interaction can't be meaningfully
  unit tested; this is inherently an OS-integration feature.
- Explicit GNOME pre-check (§3) before treating a missing icon as a code
  bug.
- Confirm Quit from the tray and Quit via the title bar's close button
  produce identical behavior — they should, since both ultimately trigger
  the same process exit, but worth confirming rather than assuming two
  independently-written exit paths stay in sync.
