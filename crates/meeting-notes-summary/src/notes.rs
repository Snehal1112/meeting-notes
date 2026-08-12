use crate::chunk::{merge_partials, split_transcript};
use meeting_notes_core::meeting::MeetingType;
use meeting_notes_core::summary::{SummaryPass, SummaryProgress, SummaryProvider, SummaryResult};

/// Shared framing describing the material every pass is reading.
const TRANSCRIPT_CAVEAT: &str = "The text below is a raw speech-to-text transcript produced by \
an automatic transcription system. It has no speaker labels, no turn boundaries, and no \
per-speaker timestamps: every participant's words run together as one continuous block, so a \
single sentence or paragraph may contain several different people talking. It also contains \
transcription errors, and the words most likely to be wrong are exactly the ones that matter \
most — personal names, company and product names, acronyms, and technical jargon.\n\n\
Work only from what the transcript actually says, but do work: reading the conversation \
carefully and drawing well-grounded conclusions is the job. Infer who is speaking from names \
used in address, self-introductions, handoffs, and role-revealing statements; infer ownership \
of a task from who volunteers or is assigned it; infer that something was decided when the \
group converges and the conversation moves on. Confident, specific inference from context is \
expected and is far more useful than cautious, generic hedging. What is never acceptable is \
supplying anything the transcript does not support — do not invent names, roles, titles, \
dates, numbers, tools, or outcomes, and do not paper over a gap with placeholder stand-ins such \
as Unnamed speaker, Speaker 1, or the presenter. When the text genuinely does not tell you \
something, omit it rather than fill it in; an accurate shorter answer beats a padded one.\n\n\
Handle likely mis-transcriptions by reading through them. Normalize a garbled name to the \
spelling used most often, and where an obviously-mangled common term is unambiguous from \
context, use the intended term — post grass in a discussion of databases is Postgres. Anything \
less certain than that keeps the transcript's own words the first time you use it, with your \
reading in square brackets after it: a beer bowl [possibly earbud]. Never silently swap a word \
for a more plausible-sounding one, and never add descriptive words of your own around it — a \
reader must be able to tell what was said from what you concluded. Do not build a decision, \
action item, or conclusion on top of a phrase you could not decipher. Keep the speakers' own \
name for any technology, product, tool or metric even when it looks mis-transcribed \
(electrolysis sensors, not sensors that pick up impulses); dropping the name for a generic \
paraphrase throws away the one fact-checkable detail in the sentence.\n\n\
Finally, write about the meeting, not about the transcript. Do not add general commentary on \
audio or transcription quality, do not note that speakers are unlabeled, and produce only what \
this particular request asks for. Uncertainty about a specific claim is a different thing and \
belongs in the notes: where the transcript is fragmentary or several speakers' words run \
together, write what the words actually support and mark what they do not. An exchange nobody \
clearly resolves is recorded as unresolved — not as a clarification, a confirmation, or a \
settled fact.";

/// The JSON contract every notes pass shares. Only the guidance below it
/// varies by meeting type, so `parse_pass_fragment`'s required keys, the
/// merge, and the Markdown rendering are identical for all five.
const NOTES_SHAPE: &str = r#"Respond with ONLY a JSON object of this exact shape:
{"meeting_type": string, "attendees": [string], "referenced_people": [string], "summary": string, "topics": [{"title": string, "points": [string]}], "decisions": [string]}
No preamble, no markdown fences.

- meeting_type: a short descriptor of THIS specific meeting, e.g. "Team sync - Q3 OKR review" or "Incident review - checkout 502s". Never a bare generic label like "Meeting" or "Discussion". Base the descriptor on what the audio shows, not on what the content is about: a live multi-party meeting has greetings, turn-taking, and people answering each other; one continuous explanatory voice is narration or a recorded talk however product-like its subject. When the setting is not evidenced, put that in the descriptor — "Recorded talk, setting unclear - brain-computer interface wearable" — rather than asserting a format such as a pitch, demo, standup, or review.
- attendees: ONLY people whose names are actually spoken in the transcript AND who appear to be on the call — they speak, are greeted, are asked a direct question, or answer one. Copy names as spoken; do not add roles, titles or descriptions, and do not guess who "probably" attended.
- referenced_people: named people who are talked about but not clearly present, e.g. "Priya said she'd review the PR" when Priya never speaks or responds.
- HARD RULE for both attendees and referenced_people: if the transcript names nobody for a list, return an empty array. Never invent a placeholder like "Unnamed presenter", "Unidentified team member", "Speaker 1", "Participant A" or "Host" — a placeholder is always wrong, an empty array is always correct. Never promote a merely-mentioned name into attendees just to avoid an empty list.
- summary: ONE dense paragraph of 4-6 sentences, longer if the meeting was substantial, covering what was discussed, why it mattered, and what came out of it. Name the people, teams and systems involved and include every concrete number stated — dates, counts, percentages, durations, versions, deadlines. Write it so someone who missed the meeting needs nothing else; vague filler sentences are a failure. Every number must come from the transcript, not from your own tallying. Do not report how many times something happened or was said unless a speaker gave the figure — describe it instead ("the same sentence repeats for the whole recording"), and never approximate a count with words like dozens or hundreds.
- decisions: things the group explicitly settled, disagreed on, or set aside — never a bare list of what got approved. Prefix every entry with its outcome in square brackets: "[Agreed]" when the group settled on it, "[Disagreed]" when they explicitly took different positions on it and never reconciled, or "[Shelved]" when they explicitly set it aside rather than deciding. After the tag, state what was decided, disputed, or shelved, and who it applies to if said. A proposal nobody responded to at all carries none of these outcomes — it stays a proposal and belongs in topics only, not decisions. Use an empty array if the group settled, disputed, or shelved nothing. Never state something in decisions that your own topics points describe as merely proposed, suggested, or floated with no response.
- topics: split the meeting into the real subjects covered; "title" names the subject, "points" carries the substance. Every point must be DETAILED and SPECIFIC — names, numbers, dates, direct quotes, stated reasons, and any disagreement or pushback. Aim for 4-10 points per topic. Prefer concrete detail over generalisation:
  BAD (too vague): "The team discussed API performance issues."
  GOOD: "Checkout API p95 hit 1.8s after Tuesday's deploy; Maya blamed the new pricing join, Tom pushed back that traffic doubled the same day.""#;

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

/// The shared persona line, sent once as part of the cached `system` prompt
/// (see `ClaudeProvider::build_request_body`) rather than repeated inside
/// every meeting-type guidance const.
const SYSTEM_PERSONA: &str = "You write detailed meeting notes from raw transcripts.";

/// The user did not commit to a kind of meeting, so the model infers the
/// structure from the content. This is the behaviour every meeting had
/// before meeting types existed.
const GENERIC_GUIDANCE: &str = "First infer what kind of meeting this was — a round of status \
updates, a working discussion that reached decisions, a brainstorm, narration or a recorded \
talk from one continuous speaker, or a conversation with no clear structure at all — and let \
that inference shape the topics instead of forcing a template onto it. Use one topic per \
distinct subject in the order it was first raised, starting a new topic when the subject \
changes rather than when the speaker changes, and folding a subject the group drifted back to \
later into its existing topic instead of repeating it. Title each topic with the actual \
subject in the participants' own words — the project, system, customer, metric or decision \
being discussed — never a generic label like \"Discussion\", \"Updates\", \"General\" or \
\"Next steps\".";

const STANDUP_GUIDANCE: &str = "You write notes for a standup. Give each person who spoke \
their own topic, titled with just their name, and never merge two people's updates into a \
single topic. The transcript has no speaker labels, so infer who is talking from names said \
out loud — someone naming themselves, someone handing off (go ahead, Priya), or someone being \
addressed or thanked by name — and treat phrases like that's it for me, I'll go next, or \
anything else, before I hand over as the boundary between one update and the next. Names may \
be mis-transcribed; prefer the spelling used most often, and if an update genuinely cannot be \
attributed to anyone, title that topic Unattributed update rather than guessing a name or \
folding it into someone else's.\n\n\
Within each person's points, cover what they finished, what they are picking up next, and \
anything blocking them, in that order. Keep every point specific: name the ticket, service, \
PR, customer, environment, or number that was actually spoken. Points like made progress on \
the migration or continuing with previous work are failures — say what moved, how far, and \
what remains. If a person did not mention one of the three, leave it out rather than padding \
it with filler.\n\n\
Record a blocker even when nobody offered a fix, and state what it is waiting on — a person, a \
review, an environment, an external team, a decision. An unresolved blocker with no proposed \
solution is the most useful line in these notes and must never be dropped just because the \
group moved on without settling it. Finally, add one topic for anything the group discussed \
outside the individual updates, only if there was any.";

const RETROSPECTIVE_GUIDANCE: &str = "You write notes for a retrospective. Use topics titled \
exactly \"What went well\", \"What did not go well\", and \"Ideas and experiments\", in that \
order, and drop any of the three the team did not actually discuss — never pad a section with \
filler to complete the set.\n\n\
Sort each point by what the speaker meant, not by its tone. Something that shipped, held up, \
or improved goes under \"What went well\"; friction, incidents, delays, and frustrations go \
under \"What did not go well\"; anything forward-looking the team proposed trying goes under \
\"Ideas and experiments\", even if it surfaced in the middle of a complaint. One stretch of \
discussion often yields points in two or three sections — split it rather than filing the \
whole thread in one place.\n\n\
Make every point concrete. Anchor it to the specific incident, release, ticket, tool, or \
number actually mentioned (\"the Thursday deploy rolled back twice\", \"review sat three days \
on the payments PR\"), and state proposed experiments precisely enough to act on, including \
any trial period, owner, or success signal the team named. Drop anything that would read \
identically for any team, such as \"communication could improve\" or \"collaboration was \
good\".\n\n\
The transcript has no speaker labels. Attribute a point to a person only when the transcript \
makes it unambiguous — someone is addressed by name and then answers, or a speaker identifies \
themselves. Otherwise write the point with no attribution; an unattributed point is far better \
than a misattributed one.\n\n\
Keep disagreement visible. When people took different positions on the same item, record both \
positions inside that one point and say plainly that views differed, naming who held which \
view only when that is clear. Leave unresolved items marked as unresolved, note when a \
complaint was raised and pushed back on, and preserve the strength of the language used. Do \
not merge conflicting views into a single consensus sentence, average them into a neutral \
middle, or soften sharp criticism into diplomatic phrasing — the unresolved tension is the \
most valuable output of a retrospective.";

const FEATURE_REQUEST_GUIDANCE: &str = "You write notes for a feature request discussion. Use \
topics titled \"Problem\", \"Proposed solution\", \"Requirements\", \"Concerns and risks\", and \
\"Alternatives considered\", in that order, dropping any topic the group did not actually \
cover. Do not merge two of them into one, and do not invent a section the transcript does not \
support.\n\n\
Sort the discussion by what each part is, not by when it was said — a real conversation loops \
back, so a requirement raised while arguing about risk still belongs under \"Requirements\". \
Use \"Problem\" for the pain or gap that prompted the request: who hits it, when, and what \
they do today instead. Use \"Proposed solution\" for what the group wants built, described as \
behaviour, not as a restatement of the problem.\n\n\
Put every stated requirement as its own point, including the ones raised in passing. A \
constraint dropped in a half-sentence aside is as binding as one debated for ten minutes — \
sweep the whole transcript for them. Include negative constraints (\"it must not…\"), \
deadlines, scale and platform limits, permissions, and things stated as obvious assumptions.\n\n\
Write each point so a reader who missed the meeting could tell whether the shipped feature \
satisfies it. \"Needs to be fast\" is not usable; \"results in under a second on a \
ten-thousand-row list\" is. If the transcript only offers the vague version, keep the \
speakers' own wording rather than inventing precision nobody stated.\n\n\
The transcript has no speaker labels. Record who asked for something only when the transcript \
makes it unmistakable — a name is spoken or someone identifies themselves. Otherwise state the \
requirement with no owner. Never guess, and never reuse one name across nearby points.\n\n\
Keep rejected alternatives and the reason each was rejected — cost, timing, technical limit, a \
past attempt that failed. Without that trail the same idea gets re-proposed months later. If \
an option was parked rather than rejected, say so and note what would reopen it.";

const INCIDENT_GUIDANCE: &str = "You write notes for an incident review. Build topics with the \
titles \"Timeline\", \"Impact\", \"Root cause\", \"Remediation\" and \"Prevention\", in that \
order, dropping any the group did not actually cover and inventing none of your own.\n\n\
Incident discussions wander — the group jumps backwards and forwards through the event and \
revises earlier statements. Order Timeline points by when things happened, not by when they \
were talked about, and prefer a later correction over the first version of a detail.\n\n\
Carry every time, date and duration spoken aloud into the Timeline point it belongs to, and \
every figure spoken aloud — users affected, failed requests, error rate, minutes of downtime, \
cost — into Impact. Reproduce them as stated: do not round, convert, re-derive or smooth them, \
and do not add precision nobody gave. The transcript is raw speech-to-text and garbles \
numbers; when a figure looks mangled or ambiguous, keep what was said and flag the uncertainty \
rather than guessing the intended value. \"We were down for a while\" is a failed Impact \
point; \"about 40 minutes of 5xx errors, roughly 2,000 users affected\" is a good one.\n\n\
Be strict about the root cause. Put something under \"Root cause\" only if the group \
confirmed it. If they were still theorizing, state plainly that the root cause was not \
established, then record the leading theories as unconfirmed hypotheses together with the \
evidence or check still outstanding. Never promote a hypothesis to a cause because it sounded \
convincing.\n\n\
Remediation is what was actually done to stop the bleeding — the fix or mitigation, when it \
landed, and who did it if a name was spoken. Prevention is the work agreed to stop a \
recurrence. Keep the two apart even when they were discussed in the same breath.";

/// Pass B: action items, asked for on their own because a combined prompt
/// returns an empty array for them on smaller models.
const PASS_ACTIONS: &str = r#"Extract every concrete follow-up task from this meeting transcript. Respond with ONLY a JSON object of this exact shape:
{"action_items": [{"text": string, "owner": string or null}]}
No preamble, no markdown fences.

Scan the whole transcript, start to end — tasks are scattered through the discussion, not gathered at the end.

A task is anything someone committed to do, was asked to do, or the group agreed needs doing.
Include implied tasks, but only where someone actually proposed doing something: a stated intention, an offer, or a need the group agreed on counts even when nobody was assigned. "We should add X to the agenda" becomes "Add X to the agenda". A problem being reported, discussed, or theorised about is not a task. Record the follow-up somebody actually named — "Reach out to the customer about the naming issue", "Check whether staging and production run the same version" — never a repair nobody committed to, such as "Fix the naming issue". Watch for follow-ups dropped mid-sentence — offers to send, check, chase, book, write up or look into something.
Write "text" as one imperative task starting with a verb, specific enough to act on without reading the transcript: keep the names, numbers, systems, dates and deadlines that were actually said. One task per item — do not bundle two tasks into one line or split one task across two.
Leave out work already finished, and discussion or opinion that carried no follow-up.
"owner" is the person the transcript itself attaches to that task — they said they would do it, or someone named them. Otherwise null. Raising the problem, proposing the idea, or offering the hypothesis the task came out of is not ownership — when a task derives from a suggestion made to the group rather than a commitment by one person, the owner is null. Never guess an owner from role, seniority, expertise, who was talking, or whose topic it was, and never invent a placeholder name. When it is not clearly stated, null is the correct answer; a wrong owner is worse than no owner. An unowned task is still a task — always keep it.
Be thorough. Transcripts usually hold more follow-ups than a quick pass finds, so re-read for the ones stated in passing. Do not pad the list toward a target count — return exactly what the transcript supports, and an empty array if it contains no follow-up of any kind."#;

/// Pass C: open questions, asked for on its own for the same reason as B.
const PASS_QUESTIONS: &str = r#"Extract the unresolved questions from this meeting transcript: things raised but left unanswered, and things the group considered but explicitly did not settle on. A question belongs here only if the transcript leaves it hanging — not every question someone says out loud is an open question. Respond with ONLY a JSON object of this exact shape:
{"open_questions": [string]}
No preamble, no markdown fences.

Include: questions asked that nobody answered; questions the group argued over without landing on an answer; and questions they explicitly agreed to defer, park, or take offline, since "let's come back to this next week" leaves the question open. Include unknowns stated as flat sentences rather than as questions, e.g. "we still don't know what's causing the slowdown" becomes "What is causing the slowdown?". Exclude rhetorical and conversational filler ("does that make sense?", "can you hear me?"), and exclude any question that someone answers later on — read the whole transcript before deciding, because the answer often comes minutes after the question. Write each entry as one self-contained question carrying enough context to stand on its own without the transcript, and prefix it with the name of the person who raised it or who owes the answer when the transcript makes that clear, e.g. "Sarah: who owns the rollback plan?". Aim for 3-6 questions when the material supports it, and return an empty array if nothing was genuinely left unresolved."#;

/// One generation pass: its prompt, and the top-level JSON key(s) a
/// well-formed response must carry. Every `SummaryResult` field is
/// `#[serde(default)]` so serde alone cannot tell "the model answered with an
/// empty section" from "the model answered a different question entirely" —
/// checking for the owning key(s) is what catches the latter.
struct Pass<'a> {
    tag: SummaryPass,
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
    on_progress: impl Fn(SummaryProgress) + Send + Sync,
) -> Result<SummaryResult, String> {
    let notes_prompt = notes_pass_for(meeting_type);
    let passes = [
        // The notes pass owns several fields; requiring topics and summary is
        // enough to catch a response shaped for a different prompt without
        // demanding every field (e.g. decisions is legitimately often empty).
        Pass {
            tag: SummaryPass::NotesAndSummary,
            prompt: notes_prompt.as_str(),
            required_keys: &["topics", "summary"],
        },
        Pass { tag: SummaryPass::ActionItems, prompt: PASS_ACTIONS, required_keys: &["action_items"] },
        Pass { tag: SummaryPass::OpenQuestions, prompt: PASS_QUESTIONS, required_keys: &["open_questions"] },
    ];

    let chunks = split_transcript(transcript, provider.input_budget_words());
    if chunks.is_empty() {
        return Err("transcript is empty, nothing to summarize".to_string());
    }
    let chunk_total = chunks.len();
    let system = format!("{SYSTEM_PERSONA}\n\n{TRANSCRIPT_CAVEAT}");

    let mut fragments = Vec::new();
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let transcript_block = format!("Transcript:\n{chunk}");
        for pass in &passes {
            on_progress(SummaryProgress { pass: pass.tag, chunk_index, chunk_total });
            let raw = provider.complete_json(&system, &transcript_block, pass.prompt).await?;
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
