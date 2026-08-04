use crate::chunk::{merge_partials, split_transcript};
use meeting_notes_core::meeting::MeetingType;
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};

/// Shared framing describing the material every pass is reading.
const TRANSCRIPT_CAVEAT: &str = "The transcript is raw speech-to-text with no speaker labels \
and may contain transcription errors. Infer speakers from names spoken in context. Where a \
term is likely mis-transcribed, give your best-guess interpretation. Use ONLY information \
present in the transcript. Do not invent details.";

/// The JSON contract every notes pass shares. Only the guidance below it
/// varies by meeting type, so `parse_pass_fragment`'s required keys, the
/// merge, and the Markdown rendering are identical for all five.
const NOTES_SHAPE: &str = r#"Respond with ONLY a JSON object of this exact shape:
{"meeting_type": string, "attendees": [string], "referenced_people": [string], "summary": string, "topics": [{"title": string, "points": [string]}], "decisions": [string]}
No preamble, no markdown fences.

- meeting_type: a short descriptor of this specific meeting, e.g. "Team sync - Q3 OKR review".
- attendees: people who appear to be ON the call, using ONLY names actually stated in the transcript. referenced_people: people mentioned but not clearly present. If no one is named for either list, use an empty array — never invent a placeholder description like "Unnamed presenter" or "Unidentified team member".
- summary: ONE substantial paragraph of 4-6 sentences covering what was discussed and what came out of it. Include concrete numbers.
- decisions: things the group settled on. Empty array if none.
- topics: "points" must be DETAILED and SPECIFIC — names, numbers, dates, direct quotes, stated reasons and any pushback. Aim for 4-10 points per topic. Prefer concrete detail over generalisation."#;

/// Returns the notes-pass prompt for `meeting_type`.
///
/// Only this pass varies by type. Actions and open questions are asked for
/// identically whatever the meeting was — narrowing those two prompts is
/// what stops small models returning empty arrays for them, and that has
/// nothing to do with the kind of meeting.
pub fn notes_pass_for(meeting_type: MeetingType) -> String {
    let guidance = match meeting_type {
        MeetingType::Standup => STANDUP_GUIDANCE,
        MeetingType::Retrospective => RETROSPECTIVE_GUIDANCE,
        MeetingType::FeatureRequest => FEATURE_REQUEST_GUIDANCE,
        MeetingType::Incident => INCIDENT_GUIDANCE,
        MeetingType::AutoDetect => GENERIC_GUIDANCE,
    };
    format!("{guidance}\n\n{NOTES_SHAPE}")
}

/// The user did not commit to a kind of meeting, so the model infers the
/// structure from the content. This is the behaviour every meeting had
/// before meeting types existed.
const GENERIC_GUIDANCE: &str = "You write detailed meeting notes from raw transcripts. \
Use one topic per distinct subject, in the order discussed.";

const STANDUP_GUIDANCE: &str = "You write notes for a standup. Use ONE topic per person who \
gave an update, titled with their name, and put what they completed, what they are working on \
next, and anything blocking them in that person's points. Add a final topic for anything the \
group discussed outside the individual updates, only if there was any. Record a blocker even \
when nobody offered a fix — an unresolved blocker is the most useful thing in these notes.";

const RETROSPECTIVE_GUIDANCE: &str = "You write notes for a retrospective. Use topics titled \
exactly \"What went well\", \"What did not go well\", and \"Ideas and experiments\", in that \
order, and drop any of the three the team did not actually discuss. Attribute points to the \
person who raised them where the transcript makes that clear, and keep disagreement visible \
rather than smoothing it into consensus.";

const FEATURE_REQUEST_GUIDANCE: &str = "You write notes for a feature request discussion. Use \
topics titled \"Problem\", \"Proposed solution\", \"Requirements\", \"Concerns and risks\", and \
\"Alternatives considered\", in that order, dropping any the group did not cover. Put every \
stated requirement as its own point, including the ones raised in passing, and record who \
asked for it. Keep rejected alternatives and the reason each was rejected.";

const INCIDENT_GUIDANCE: &str = "You write notes for an incident review. Use topics titled \
\"Timeline\", \"Impact\", \"Root cause\", \"Remediation\", and \"Prevention\", in that order, \
dropping any the group did not cover. Timeline points must carry whatever times, dates and \
durations were said aloud. Impact points must carry the numbers stated — users affected, \
duration, error rates. If the root cause was not established, say so plainly instead of \
presenting a hypothesis as the cause.";

/// Pass B: action items, asked for on their own because a combined prompt
/// returns an empty array for them on smaller models.
const PASS_ACTIONS: &str = r#"Extract every concrete follow-up task from this meeting transcript. Respond with ONLY a JSON object of this exact shape:
{"action_items": [{"text": string, "owner": string or null}]}
No preamble, no markdown fences.

A task is anything someone committed to do, was asked to do, or the group agreed needs doing.
Include implied tasks, e.g. "we should add X to the agenda" becomes "Add X to the agenda".
"owner" is the named person if the transcript names one, otherwise null. Never guess an owner.
Be thorough: aim for 5-8 items when the material supports it."#;

/// Pass C: open questions, asked for on its own for the same reason as B.
const PASS_QUESTIONS: &str = r#"Extract unresolved questions from this meeting transcript: things raised but left unanswered, or where the group explicitly did not settle on an answer. Respond with ONLY a JSON object of this exact shape:
{"open_questions": [string]}
No preamble, no markdown fences."#;

/// One generation pass: its prompt, and the top-level JSON key(s) a
/// well-formed response must carry. Every `SummaryResult` field is
/// `#[serde(default)]` so serde alone cannot tell "the model answered with an
/// empty section" from "the model answered a different question entirely" —
/// checking for the owning key(s) is what catches the latter.
struct Pass<'a> {
    prompt: &'a str,
    required_keys: &'static [&'static str],
}

/// Generates the full notes for `transcript`.
///
/// Runs three focused passes rather than one combined prompt: asking a small
/// model for every field at once measurably returns empty arrays for whole
/// sections, while narrow prompts recover them. A transcript longer than the
/// provider's budget is chunked, every pass runs per chunk, and the
/// fragments are merged.
///
/// `meeting_type` selects the notes pass only. Every variant asks for the
/// same JSON shape, so it steers what the model looks for without changing
/// the contract the parser, merge and renderer depend on.
pub async fn generate_notes(
    provider: &(dyn SummaryProvider + Send + Sync),
    meeting_type: MeetingType,
    transcript: &str,
) -> Result<SummaryResult, String> {
    let notes_prompt = notes_pass_for(meeting_type);
    let passes = [
        // The notes pass owns several fields; requiring topics and summary is
        // enough to catch a response shaped for a different prompt without
        // demanding every field (e.g. decisions is legitimately often empty).
        Pass { prompt: notes_prompt.as_str(), required_keys: &["topics", "summary"] },
        Pass { prompt: PASS_ACTIONS, required_keys: &["action_items"] },
        Pass { prompt: PASS_QUESTIONS, required_keys: &["open_questions"] },
    ];

    let chunks = split_transcript(transcript, provider.input_budget_words());
    if chunks.is_empty() {
        return Err("transcript is empty, nothing to summarize".to_string());
    }

    let mut fragments = Vec::new();
    for chunk in &chunks {
        for pass in &passes {
            let prompt = format!("{}\n\n{TRANSCRIPT_CAVEAT}\n\nTranscript:\n{chunk}", pass.prompt);
            let raw = provider.complete_json(&prompt).await?;
            fragments.push(parse_pass_fragment(&raw, pass.required_keys)?);
        }
    }

    Ok(merge_partials(fragments))
}

/// Parses one pass's JSON fragment into a partially-filled `SummaryResult`.
///
/// Every field of `SummaryResult` defaults, so serde alone would silently
/// accept a fragment carrying none of its expected keys (e.g. the model
/// answered with `{"questions": [...]}` instead of `{"open_questions":
/// [...]}`) and return an empty result instead of an error. Checking that
/// every key in `required_keys` is present — not necessarily non-empty —
/// catches that: a section with genuinely nothing to report (e.g. no open
/// questions) is still valid.
pub fn parse_pass_fragment(raw: &str, required_keys: &[&str]) -> Result<SummaryResult, String> {
    let stripped = strip_code_fences(raw);
    let value: serde_json::Value = serde_json::from_str(stripped)
        .map_err(|e| format!("failed to parse LLM response as JSON: {e}"))?;

    let object = value
        .as_object()
        .ok_or_else(|| format!("expected a JSON object, got: {stripped}"))?;

    for key in required_keys {
        if !object.contains_key(*key) {
            let present: Vec<&str> = object.keys().map(String::as_str).collect();
            return Err(format!(
                "LLM response is missing required key \"{key}\"; keys present: [{}]",
                present.join(", ")
            ));
        }
    }

    serde_json::from_value(value).map_err(|e| format!("failed to parse LLM response as JSON: {e}"))
}

/// Removes a ```json ... ``` wrapper. Models add these despite being told
/// not to, and it is a trivially recoverable formatting slip rather than a
/// reason to fail the whole summarize.
fn strip_code_fences(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    // Drop the optional language tag on the opening fence.
    let rest = rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest);
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}
