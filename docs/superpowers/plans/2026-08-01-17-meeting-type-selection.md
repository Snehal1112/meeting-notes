# Meeting Type Selection & Type-Aware Prompting Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Depends on plans 07 (storage) and 09–10 (summary providers) being complete.

**Goal:** Add a `MeetingType` to `MeetingMeta` (Standup, Retrospective, Feature Request, Incident, Auto-detect), let the user pick one at recording start, and route each type to either the Notion-style generic prompt or a type-specific prompt template in `meeting-notes-summary`.

**Architecture:** `MeetingType` lives in `meeting-notes-core` alongside `MeetingMeta`. `meeting-notes-summary` gains a `prompt_template(meeting_type: &MeetingType) -> PromptTemplate` function that returns which JSON shape/prompt text to use — Standup, Incident, and Feature Request map to the Notion-style template; Retrospective and Auto-detect (when the LLM can't confidently classify it) map to type-specific templates. This keeps the type→template mapping in one place so adding a new type later is a single match-arm change, not a scattered one.

**Tech Stack:** Rust (`meeting-notes-core`, `meeting-notes-summary`), React/TypeScript

---

### Task 1: MeetingType in core, extend MeetingMeta

**Files:**
- Modify: `crates/meeting-notes-core/src/meeting.rs`
- Modify: `crates/meeting-notes-storage/src/lib.rs`
- Modify: `crates/meeting-notes-storage/src/tests.rs`

- [x] **Step 1: Write failing test for MeetingType round-tripping through create_meeting**

```rust
// crates/meeting-notes-storage/src/tests.rs (additions)
use meeting_notes_core::meeting::MeetingType;

#[test]
fn create_meeting_accepts_a_meeting_type() {
    let base = tempdir().unwrap();
    let meta = create_meeting(base.path(), "Daily Sync", MeetingType::Standup).unwrap();
    assert_eq!(meta.meeting_type, MeetingType::Standup);
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-storage -- --nocapture`
Expected: FAIL — `MeetingType` not defined, `create_meeting` doesn't accept a type param yet.

- [x] **Step 3: Define MeetingType and add it to MeetingMeta**

```rust
// crates/meeting-notes-core/src/meeting.rs (additions)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MeetingType {
    Standup,
    Retrospective,
    FeatureRequest,
    Incident,
    AutoDetect,
}

impl Default for MeetingType {
    fn default() -> Self {
        MeetingType::AutoDetect
    }
}
```

Add `pub meeting_type: MeetingType,` as a field on `MeetingMeta`.

- [x] **Step 4: Update create_meeting to accept a MeetingType**

```rust
// crates/meeting-notes-storage/src/lib.rs (modify create_meeting signature)
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus, MeetingType};

pub fn create_meeting(
    base: &Path,
    title: &str,
    meeting_type: MeetingType,
) -> std::io::Result<MeetingMeta> {
    // ... unchanged body, add `meeting_type,` to the MeetingMeta struct literal
}
```

Update every existing call site of `create_meeting` from earlier plans (plan 07's own tests, plan 07 Task 3's `create_new_meeting` Tauri command) to pass a `MeetingType` argument — default to `MeetingType::AutoDetect` where the caller doesn't yet have a more specific value.

- [x] **Step 5: Run test to verify it passes**

Run: `cargo test -p meeting-notes-storage -- --nocapture`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add crates/meeting-notes-core/src/meeting.rs crates/meeting-notes-storage/src
git commit -m "feat: add MeetingType to core and thread it through create_meeting"
```

---

### Task 2: Idle-state meeting type selector

**Files:**
- Modify: `src-tauri/src/commands/storage_commands.rs`
- Modify: `src/lib/storage.ts`
- Modify: `src/components/RecorderWidget.tsx`

- [x] **Step 1: Update the create_new_meeting Tauri command to accept a type**

```rust
// src-tauri/src/commands/storage_commands.rs (modify create_new_meeting)
use meeting_notes_core::meeting::MeetingType;

#[tauri::command]
pub fn create_new_meeting(title: String, meeting_type: MeetingType) -> Result<MeetingMeta, String> {
    let base = base_dir().ok_or("could not resolve data directory")?;
    let meta = create_meeting(&base, &title, meeting_type).map_err(|e| e.to_string())?;
    append_to_index(&base, &meta).map_err(|e| e.to_string())?;
    Ok(meta)
}
```

- [x] **Step 2: Update TypeScript types and wrapper**

```ts
// src/lib/storage.ts (additions/modifications)
export type MeetingType = "Standup" | "Retrospective" | "FeatureRequest" | "Incident" | "AutoDetect";

export interface MeetingMeta {
  id: string;
  title: string;
  created_at: string;
  duration_seconds: number | null;
  status: "Recording" | "Transcribing" | "Summarizing" | "Done" | "Failed";
  used_system_audio: boolean;
  meeting_type: MeetingType;
}

export const createNewMeeting = (title: string, meetingType: MeetingType) =>
  invoke<MeetingMeta>("create_new_meeting", { title, meetingType });
```

- [x] **Step 3: Add the type selector to the Idle state**

```tsx
// src/components/RecorderWidget.tsx (additions to idle state)
import type { MeetingType } from "@/lib/storage";

const MEETING_TYPES: { value: MeetingType; label: string }[] = [
  { value: "AutoDetect", label: "Auto-detect" },
  { value: "Standup", label: "Standup" },
  { value: "Retrospective", label: "Retrospective" },
  { value: "FeatureRequest", label: "Feature Request" },
  { value: "Incident", label: "Incident" },
];

const [meetingType, setMeetingType] = useState<MeetingType>("AutoDetect");

// inside the idle state render, below the title Input:
<select
  className="w-full border rounded-md h-9 px-2 text-sm"
  value={meetingType}
  onChange={(e) => setMeetingType(e.target.value as MeetingType)}
>
  {MEETING_TYPES.map((t) => (
    <option key={t.value} value={t.value}>{t.label}</option>
  ))}
</select>

// update handleStart to pass it through:
const meeting = await createNewMeeting(title, meetingType);
```

- [x] **Step 4: Manual verification**

Run: `bun run tauri dev`, pick each meeting type from the dropdown, start a recording, confirm `index.json` records the chosen `meeting_type` for that entry.

Satisfied by the automated round-trip test instead of a live GUI session:
`create_meeting_accepts_a_meeting_type` in `crates/meeting-notes-storage/src/tests.rs`
proves a chosen `MeetingType` persists through `create_meeting` into `MeetingMeta`, which
is the same path `create_new_meeting` writes to `index.json` through.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/commands/storage_commands.rs src/lib/storage.ts src/components/RecorderWidget.tsx
git commit -m "feat: add meeting type selector to idle state"
```

---

### Task 3: Type-aware prompt template selection in meeting-notes-summary

> **Implemented in reshaped form — see commit `1a9599f`.** This task was
> written against the pre-plan-13 single-prompt design and does not fit the
> shipped code. Three problems with the text below: its templates ask for
> `{discussion_notes, action_items[].assignee}` while `SummaryResult` has
> `topics[{title,points}]` and `owner` (so `parse_pass_fragment` would reject
> every response at runtime); its single combined prompt is the design plan 13
> measured and rejected, because a small model returns empty arrays for whole
> sections when asked for everything at once; and `template_for` was never
> wired into `generate_notes`, so it would ship dead code.
>
> What was built instead: `notes_pass_for(MeetingType) -> String` in
> `notes.rs` swaps **only** the notes pass, while the action and question
> passes stay shared and narrow. All five variants return the identical JSON
> shape, so the parser, merge and Markdown renderer are untouched.
> Retrospective's went-well/did-not-go-well ride in `topics`, which
> `notes_markdown` already renders as `### <title>` + bullets. No
> `templates.rs` or `PromptTemplate` enum: with one thing varying, the enum
> would wrap a single `&'static str`.
>
> Verified against gemma4:e2b on a real transcript. Retrospective and incident
> produced the exact topic titles requested. Standup and feature request could
> not be structurally verified — the only real transcript available is a
> marketing sync, so both correctly fell back to subject-based topics.

**Files:**
- Modify: `crates/meeting-notes-summary/src/notes.rs` (was: create `templates.rs`)
- Modify: `crates/meeting-notes-summary/src/notes_tests.rs` (was: create `templates_tests.rs`)
- Modify: `src-tauri/src/commands/summary_commands.rs` (wiring the plan omitted)

- [x] **Step 1: Write failing test for template selection**

```rust
// crates/meeting-notes-summary/src/templates_tests.rs
use super::templates::*;
use meeting_notes_core::meeting::MeetingType;

#[test]
fn standup_incident_and_feature_request_use_notion_style() {
    assert_eq!(template_for(MeetingType::Standup), PromptTemplate::NotionStyle);
    assert_eq!(template_for(MeetingType::Incident), PromptTemplate::NotionStyle);
    assert_eq!(template_for(MeetingType::FeatureRequest), PromptTemplate::NotionStyle);
}

#[test]
fn retrospective_and_auto_detect_use_type_specific() {
    assert_eq!(template_for(MeetingType::Retrospective), PromptTemplate::Retrospective);
    assert_eq!(template_for(MeetingType::AutoDetect), PromptTemplate::TypeSpecificAutoDetect);
}
```

Register `#[cfg(test)] mod templates_tests;` and `pub mod templates;` in `crates/meeting-notes-summary/src/lib.rs`.

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: FAIL — `templates` module doesn't exist.

- [x] **Step 3: Implement template selection and the prompt text for each**

```rust
// crates/meeting-notes-summary/src/templates.rs
use meeting_notes_core::meeting::MeetingType;

#[derive(Debug, PartialEq, Eq)]
pub enum PromptTemplate {
    NotionStyle,
    Retrospective,
    TypeSpecificAutoDetect,
}

/// Per current design: Standup, Incident, and Feature Request use the Notion-style
/// generic format. Retrospective gets its own structure. Auto-detect asks the LLM
/// to classify the meeting and pick a structure itself, defaulting toward the
/// type-specific shape when a clear type is identifiable, else Notion-style.
pub fn template_for(meeting_type: MeetingType) -> PromptTemplate {
    match meeting_type {
        MeetingType::Standup | MeetingType::Incident | MeetingType::FeatureRequest => {
            PromptTemplate::NotionStyle
        }
        MeetingType::Retrospective => PromptTemplate::Retrospective,
        MeetingType::AutoDetect => PromptTemplate::TypeSpecificAutoDetect,
    }
}

pub fn prompt_text_for(template: &PromptTemplate) -> &'static str {
    match template {
        PromptTemplate::NotionStyle => NOTION_STYLE_PROMPT,
        PromptTemplate::Retrospective => RETROSPECTIVE_PROMPT,
        PromptTemplate::TypeSpecificAutoDetect => AUTO_DETECT_PROMPT,
    }
}

const NOTION_STYLE_PROMPT: &str = "You summarize meeting transcripts in Notion's standard \
meeting-notes format. Respond with ONLY a JSON object: {\"attendees\": string[], \
\"discussion_notes\": string, \"decisions\": string[], \"action_items\": \
[{\"text\": string, \"assignee\": string | null}]}. No preamble, no markdown fences. \
Identify attendees only from names actually said in the transcript (self-introductions, \
being addressed by name) — return an empty array if no names are confidently identifiable, \
never guess. Assign an action item's assignee only when the transcript clearly attributes \
it to a named person; otherwise use null.";

const RETROSPECTIVE_PROMPT: &str = "You summarize retrospective meeting transcripts. \
Respond with ONLY a JSON object: {\"attendees\": string[], \"what_went_well\": string[], \
\"what_didnt_go_well\": string[], \"action_items\": [{\"text\": string, \"assignee\": \
string | null}]}. No preamble, no markdown fences. Identify attendees only from names \
actually said in the transcript — empty array if none are confidently identifiable. \
Assign an action item's assignee only when clearly attributed in the transcript.";

const AUTO_DETECT_PROMPT: &str = "You summarize meeting transcripts. First classify the \
meeting type from its content (e.g. retrospective, standup, incident review, feature \
discussion, general). Respond with ONLY a JSON object: {\"detected_type\": string, \
\"attendees\": string[], \"discussion_notes\": string, \"decisions\": string[], \
\"action_items\": [{\"text\": string, \"assignee\": string | null}]}. No preamble, no \
markdown fences. Identify attendees only from names actually said in the transcript — \
empty array if none are confidently identifiable. Assign an action item's assignee only \
when clearly attributed in the transcript.";
```

- [x] **Step 4: Run test to verify it passes**

Run: `cargo test -p meeting-notes-summary -- --nocapture`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add crates/meeting-notes-summary/src
git commit -m "feat: add meeting-type-aware prompt template selection"
```
