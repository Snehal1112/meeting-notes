# Meeting History — Design Spec

**Date:** 2026-08-06
**Status:** Approved, ready for implementation (Plans 27 backend + 28 frontend)
**Depends on:** Plan 22 (`summary_result.json` persistence, used for snippets),
Plan 24 (removes Done, establishes `openPath` as the standard file-reveal
mechanism, and is the reason this feature exists at all), Plan 25 (the
gear-icon-in-TitleBar precedent this reuses for the History icon).

## 1. Why This Exists

Plan 24 removes the Done screen. Its replacement — a "Last meeting" link on
Idle — is explicitly session-scoped: it resets on every app restart. The
practical consequence, stated plainly: **once you close a summary.md and
restart the app, there is currently no way back to any past meeting from
inside the app at all.** Meeting History closes that gap. It isn't a "nice to
have" addition so much as a correction to a real regression Plan 24 opens.

## 2. Scope Decisions

**Client-side filtering/search/pagination, not server-side.** `get_meeting_history()`
returns every meeting unconditionally; React state handles search, the three
filters, and slicing into pages of 5. A personal local recording app's
meeting count realistically stays in the tens-to-low-hundreds — nowhere near
enough to need a paginated backend query API. This keeps the backend to
three simple, parameter-free commands (`get_meeting_history`,
`delete_meeting`, `reveal_in_file_manager`) instead of a filter/sort/page
query surface.

**Delete-immediately-with-undo-toast, not confirm-before-delete.** Clicking
Delete removes the row from the UI immediately and shows a toast with an
Undo action; the actual `delete_meeting` backend call is deferred via
`setTimeout` until the toast's ~6-second window expires. This sidesteps the
"does this need a modal confirmation" question entirely — no `AlertDialog`
needed either way, consistent with this app's established no-real-modals
rule (documented in Plan 25's design doc, re: the always-on-top draggable
window and outside-click-dismiss conflicts).

*Stated tradeoff, not a bug:* if the app quits during the undo window, the
deferred `deleteMeeting()` call never fires, and the meeting simply
reappears in history on next launch. Persisting pending-delete state across
a restart would close this gap but adds real complexity for a rare edge
case — not worth it for this pass.

**Failed meetings get a prominent Retry button, not just a status badge.**
Positioned as a primary action on the row itself (not buried in the "⋯"
menu), since it's the single most useful thing to do with a failed meeting.
Distinct from "Re-run summarization" (available for Done meetings, in the
"⋯" menu) — Retry re-attempts transcription from where it failed; Re-run
regenerates the summary from an already-successful transcript.

**Row click opens summary.md externally** — the exact same `openPath()`
mechanism Plan 24 already uses when a recording finishes. Deliberately not
a different interaction (e.g. an in-app preview) specifically because
building an in-app preview would partially resurrect the Done screen Plan
24 just removed. One "show me this meeting" action, used consistently
whether triggered by "just finished" or "clicked in history."

**Window grows taller, not wider.** Caps at 600px height, keeps Idle's
existing ~400px width — reuses whatever content-driven resize mechanism
the real app already has (`useAutoResizeWindow`, per project knowledge),
rather than introducing a second resize system alongside it.

## 3. What's Confirmed vs. What Needs Verification

This section exists specifically so open questions survive past the
conversation that raised them.

**Confirmed, low risk:**
- shadcn components used throughout: `Input`, `Select`, `Badge`,
  `DropdownMenu`/`DropdownMenuTrigger`/`DropdownMenuContent`/`DropdownMenuItem`/
  `DropdownMenuSeparator`, `Pagination`/`PaginationContent`/`PaginationPrevious`/
  `PaginationNext`, `Separator`, `Button`, and `sonner` (shadcn's current
  toast primitive — the older `Toast`/`Toaster` pair is deprecated in
  current shadcn versions, don't reach for it by habit)
- `MeetingMeta` already has everything needed for title/date/type/status/
  duration — no new fields required there

**Needs verification against the real repo before trusting the plans' code as-is:**
- **Snippet source field name** — Plan 27 assumes `summary_result.json`
  has a top-level `summary: String` field, based on fragments seen in
  project knowledge (`attendees`, `referenced_people`, `summary`, `topics`,
  `decisions`, `action_items`, `open_questions`). Confirm this field name
  exactly before the snippet extraction code is trusted.
- **Failure reason storage location** — Plan 27 guesses an `error.txt`
  file in the meeting directory. This is a genuine guess, not a confirmed
  fact — the real transcription-retry UI (referenced as already existing
  in project knowledge) must store its error message *somewhere*; find
  that real location and read from it instead of introducing a new file
  that duplicates it.
- **Retry's actual hand-off mechanism** — the single most under-specified
  part of this whole feature. Plan 28's `handleRetry` closes History and
  defers to "whatever the existing resume-orphaned-recording flow uses,"
  reasoning that Plan 12's resume flow already solves "re-enter processing
  for a meeting that didn't finish" and Retry from History is the same
  problem from a different entry point. But the actual API surface for
  triggering that from outside `RecorderWidget` (a prop? an event? a
  shared piece of state?) is unknown here and needs to be found in the
  real code, not invented fresh.

**Explicitly cut from the original spec, not silently dropped:**
- **Date filter** — the original spec asked for search + filter by
  type/status/*and date*. Three `Select` triggers already fill the
  available width at 400px; a fourth would need to either replace one of
  the existing three or move to a second row. Deferred rather than forced
  in — flagged here so it isn't forgotten, not so it's avoided forever.

## 4. Explicit Non-Goals

- No server-side query/filter API — see Scope Decisions above.
- No "trash" or recently-deleted browsing UI — once the undo window
  expires, the meeting is gone; there's no second-chance recovery beyond
  that window.
- No bulk actions (select multiple, delete several at once) — one row at a
  time, consistent with the rest of this app's minimal-surface philosophy.
- No in-app preview of a meeting's content — row click always means
  "open externally," never "show me a summary here." See the row-click
  scope decision above for why.

## 5. Testing

- **Rust:** snippet extraction and truncation (including the no-summary-
  yet case), `delete_meeting`'s directory-removal + index-update behavior
  (including the not-found case), unit tested per Plan 27.
- **Manual, on real hardware** (same standing caveat as every other plan
  in this project — no live `bun run tauri dev` walkthrough has occurred
  in the environment these plans were scoped in): empty/few/many states,
  search+filter combination logic, pagination boundary behavior (disabled
  Previous/Next at the edges), the full delete → toast → undo → restore
  cycle *and* the delete → toast → expire → confirm-gone-from-disk cycle,
  Retry's actual hand-off into Processing, Re-run's snippet refresh.
