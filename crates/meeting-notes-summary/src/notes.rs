use crate::chunk::{merge_partials, split_transcript};
use meeting_notes_core::summary::{SummaryProvider, SummaryResult};

/// Shared framing describing the material every pass is reading.
const TRANSCRIPT_CAVEAT: &str = "The transcript is raw speech-to-text with no speaker labels \
and may contain transcription errors. Infer speakers from names spoken in context. Where a \
term is likely mis-transcribed, give your best-guess interpretation. Use ONLY information \
present in the transcript. Do not invent details.";

/// Pass A: the body of the notes.
const PASS_NOTES: &str = r#"You write detailed meeting notes from raw transcripts. Respond with ONLY a JSON object of this exact shape:
{"meeting_type": string, "attendees": [string], "referenced_people": [string], "summary": string, "topics": [{"title": string, "points": [string]}], "decisions": [string]}
No preamble, no markdown fences.

- meeting_type: a short descriptor, e.g. "Team sync - Q3 OKR review".
- attendees: people who appear to be ON the call. referenced_people: people mentioned but not clearly present.
- summary: ONE substantial paragraph of 4-6 sentences covering what was discussed and what came out of it. Include concrete numbers.
- topics: one entry per distinct subject, in the order discussed. "points" must be DETAILED and SPECIFIC: include names, numbers, dates, direct quotes, stated reasons and any pushback. Aim for 4-10 points per topic. Prefer concrete detail over generalisation.
- decisions: things the group settled on. Empty array if none."#;

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

const PASSES: [&str; 3] = [PASS_NOTES, PASS_ACTIONS, PASS_QUESTIONS];

/// Generates the full notes for `transcript`.
///
/// Runs three focused passes rather than one combined prompt: asking a small
/// model for every field at once measurably returns empty arrays for whole
/// sections, while narrow prompts recover them. A transcript longer than the
/// provider's budget is chunked, every pass runs per chunk, and the
/// fragments are merged.
pub async fn generate_notes(
    provider: &(dyn SummaryProvider + Send + Sync),
    transcript: &str,
) -> Result<SummaryResult, String> {
    let chunks = split_transcript(transcript, provider.input_budget_words());
    if chunks.is_empty() {
        return Err("transcript is empty, nothing to summarize".to_string());
    }

    let mut fragments = Vec::new();
    for chunk in &chunks {
        for pass in PASSES {
            let prompt = format!("{pass}\n\n{TRANSCRIPT_CAVEAT}\n\nTranscript:\n{chunk}");
            let raw = provider.complete_json(&prompt).await?;
            fragments.push(parse_pass_fragment(&raw)?);
        }
    }

    Ok(merge_partials(fragments))
}

/// Parses one pass's JSON fragment into a partially-filled `SummaryResult`.
///
/// Every field of `SummaryResult` defaults, so a fragment carrying only its
/// own keys parses cleanly.
pub fn parse_pass_fragment(raw: &str) -> Result<SummaryResult, String> {
    serde_json::from_str(strip_code_fences(raw))
        .map_err(|e| format!("failed to parse LLM response as JSON: {e}"))
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
