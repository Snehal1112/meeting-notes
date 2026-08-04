use super::notes::{generate_notes, notes_pass_for, parse_pass_fragment};
use async_trait::async_trait;
use meeting_notes_core::meeting::MeetingType;
use meeting_notes_core::summary::SummaryProvider;
use std::sync::Mutex;

const ALL_TYPES: [MeetingType; 5] = [
    MeetingType::Standup,
    MeetingType::Retrospective,
    MeetingType::FeatureRequest,
    MeetingType::Incident,
    MeetingType::AutoDetect,
];

/// Records every prompt it is given and replays canned responses in order.
struct ScriptedProvider {
    responses: Mutex<Vec<String>>,
    prompts: Mutex<Vec<String>>,
    budget: usize,
}

impl ScriptedProvider {
    fn new(responses: Vec<&str>, budget: usize) -> Self {
        ScriptedProvider {
            responses: Mutex::new(responses.iter().rev().map(|s| s.to_string()).collect()),
            prompts: Mutex::new(Vec::new()),
            budget,
        }
    }
}

#[async_trait]
impl SummaryProvider for ScriptedProvider {
    fn input_budget_words(&self) -> usize {
        self.budget
    }
    async fn complete_json(&self, prompt: &str) -> Result<String, String> {
        self.prompts.lock().unwrap().push(prompt.to_string());
        self.responses
            .lock()
            .unwrap()
            .pop()
            .ok_or_else(|| "no scripted response left".to_string())
    }
}

struct FailingProvider;

#[async_trait]
impl SummaryProvider for FailingProvider {
    fn input_budget_words(&self) -> usize {
        1000
    }
    async fn complete_json(&self, _prompt: &str) -> Result<String, String> {
        Err("endpoint down".to_string())
    }
}

const PASS_A: &str = r#"{"meeting_type":"Team sync","attendees":["Parker"],
"referenced_people":["Craig"],"summary":"Covered Q3.",
"topics":[{"title":"Q3 OKRs","points":["Events grew to 18."]}],
"decisions":["Self-managed assignment."]}"#;
const PASS_B: &str = r#"{"action_items":[{"text":"Grab a booth slot","owner":"Parker"}]}"#;
const PASS_C: &str = r#"{"open_questions":["Who covers chat?"]}"#;

#[tokio::test]
async fn combines_all_three_passes_into_one_result() {
    let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
    let result = generate_notes(&provider, MeetingType::AutoDetect, "a short transcript").await.expect("generate");

    assert_eq!(result.meeting_type, "Team sync");
    assert_eq!(result.topics.len(), 1);
    assert_eq!(result.decisions.len(), 1);
    assert_eq!(result.action_items[0].owner.as_deref(), Some("Parker"));
    assert_eq!(result.open_questions, vec!["Who covers chat?".to_string()]);
}

#[tokio::test]
async fn runs_exactly_three_passes_for_a_transcript_that_fits() {
    let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
    generate_notes(&provider, MeetingType::AutoDetect, "one two three").await.expect("generate");
    assert_eq!(provider.prompts.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn every_pass_prompt_carries_the_transcript() {
    let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
    generate_notes(&provider, MeetingType::AutoDetect, "the distinctive transcript body").await.expect("generate");
    for prompt in provider.prompts.lock().unwrap().iter() {
        assert!(
            prompt.contains("the distinctive transcript body"),
            "a pass prompt was sent without the transcript: {prompt}"
        );
    }
}

#[tokio::test]
async fn chunks_a_long_transcript_and_runs_every_pass_per_chunk() {
    // Budget of 2 words against a 6-word transcript gives 3 chunks, so 3
    // chunks x 3 passes = 9 calls.
    let responses = vec![
        PASS_A, PASS_B, PASS_C, PASS_A, PASS_B, PASS_C, PASS_A, PASS_B, PASS_C,
    ];
    let provider = ScriptedProvider::new(responses, 2);
    let result = generate_notes(&provider, MeetingType::AutoDetect, "one two three four five six").await.expect("generate");

    assert_eq!(provider.prompts.lock().unwrap().len(), 9);
    // The same canned topic came back for every chunk and must fold to one.
    assert_eq!(result.topics.len(), 1);
    assert_eq!(result.action_items.len(), 1);
}

#[tokio::test]
async fn fails_the_whole_run_when_any_pass_fails() {
    // Partial notes rendered in the standard format would look complete
    // while silently missing a section.
    let result = generate_notes(&FailingProvider, MeetingType::AutoDetect, "a transcript").await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("endpoint down"));
}

#[tokio::test]
async fn rejects_an_empty_transcript_before_calling_the_provider() {
    let provider = ScriptedProvider::new(vec![], 1000);
    let result = generate_notes(&provider, MeetingType::AutoDetect, "   ").await;
    assert!(result.is_err());
    assert!(provider.prompts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_notes_pass_prompt_varies_by_meeting_type() {
    let mut seen: Vec<String> = Vec::new();
    for meeting_type in ALL_TYPES {
        let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
        generate_notes(&provider, meeting_type, "a transcript").await.expect("generate");
        // The notes pass runs first, so prompt 0 is the one that varies.
        seen.push(provider.prompts.lock().unwrap()[0].clone());
    }
    for (i, a) in seen.iter().enumerate() {
        for b in seen.iter().skip(i + 1) {
            assert_ne!(a, b, "two meeting types produced an identical notes prompt");
        }
    }
}

#[tokio::test]
async fn the_action_and_question_passes_are_shared_across_meeting_types() {
    // Only the notes pass is type-specific. Follow-ups and unresolved
    // questions are asked for identically whatever the meeting was, and
    // keeping them narrow is what stops small models returning empty arrays.
    let mut baseline: Option<(String, String)> = None;
    for meeting_type in ALL_TYPES {
        let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
        generate_notes(&provider, meeting_type, "a transcript").await.expect("generate");
        let prompts = provider.prompts.lock().unwrap().clone();
        let pair = (prompts[1].clone(), prompts[2].clone());
        match &baseline {
            None => baseline = Some(pair),
            Some(expected) => assert_eq!(&pair, expected),
        }
    }
}

#[tokio::test]
async fn every_meeting_type_accepts_the_same_response_shape() {
    // The type steers what the model looks for, never the JSON contract —
    // so one canned response set has to satisfy all five.
    for meeting_type in ALL_TYPES {
        let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
        let result = generate_notes(&provider, meeting_type, "a transcript")
            .await
            .unwrap_or_else(|e| panic!("{meeting_type:?} rejected the standard shape: {e}"));
        assert_eq!(result.topics.len(), 1);
        assert_eq!(result.action_items.len(), 1);
        assert_eq!(result.open_questions.len(), 1);
    }
}

#[test]
fn each_notes_pass_asks_for_what_its_meeting_type_is_about() {
    let standup = notes_pass_for(MeetingType::Standup);
    assert!(standup.contains("blocker"), "standup pass should ask about blockers");

    let retro = notes_pass_for(MeetingType::Retrospective);
    assert!(retro.contains("went well"), "retro pass should ask what went well");

    let incident = notes_pass_for(MeetingType::Incident);
    assert!(incident.contains("root cause"), "incident pass should ask for root cause");

    let feature = notes_pass_for(MeetingType::FeatureRequest);
    assert!(feature.contains("requirement"), "feature pass should ask for requirements");
}

#[test]
fn notes_pass_tells_the_model_not_to_invent_placeholder_attendees() {
    // Raw, undiarized speech-to-text with no names spoken gives the model no
    // real signal for who was on the call. Left unconstrained, it sometimes
    // fills `attendees` with a vague placeholder ("Unnamed presenter",
    // "Unidentified team member") instead of an empty array -- which then
    // renders as literal (junk) attendee text instead of letting the app's
    // existing "no attendees" fallback do its job. The prompt must rule
    // this out explicitly rather than leaving it to the model's judgement.
    for meeting_type in ALL_TYPES {
        let prompt = notes_pass_for(meeting_type);
        let lower = prompt.to_lowercase();
        assert!(
            lower.contains("empty array") && lower.contains("placeholder"),
            "{meeting_type:?} notes pass does not instruct the model to leave attendees empty \
             instead of inventing a placeholder description"
        );
    }
}

#[test]
fn every_notes_pass_requests_the_keys_the_parser_demands() {
    // parse_pass_fragment rejects a notes response missing "topics" or
    // "summary", so a prompt that forgets to ask for them fails at runtime
    // against a real model while every scripted test still passes.
    for meeting_type in ALL_TYPES {
        let prompt = notes_pass_for(meeting_type);
        for key in ["meeting_type", "attendees", "referenced_people", "summary", "topics", "decisions"] {
            assert!(
                prompt.contains(key),
                "{meeting_type:?} notes pass never mentions \"{key}\""
            );
        }
    }
}

#[test]
fn parses_a_fragment_containing_only_its_own_fields() {
    let parsed = parse_pass_fragment(PASS_B, &["action_items"]).expect("parse");
    assert_eq!(parsed.action_items.len(), 1);
    assert!(parsed.topics.is_empty());
}

#[test]
fn strips_markdown_fences_the_model_adds_despite_instructions() {
    let fenced = "```json\n{\"open_questions\":[\"Who?\"]}\n```";
    let parsed = parse_pass_fragment(fenced, &["open_questions"]).expect("parse");
    assert_eq!(parsed.open_questions, vec!["Who?".to_string()]);
}

#[test]
fn returns_an_error_for_a_malformed_fragment() {
    assert!(parse_pass_fragment("not json at all", &["open_questions"]).is_err());
}

#[test]
fn errors_when_the_required_key_is_missing_even_though_the_json_is_valid() {
    // Valid JSON, but shaped for a different question than the one asked —
    // e.g. the model used "questions" instead of "open_questions". Silently
    // parsing this to an empty SummaryResult would drop a whole section.
    let wrong_key = r#"{"questions":["Who owns this?"]}"#;
    let err = parse_pass_fragment(wrong_key, &["open_questions"]).unwrap_err();
    assert!(err.contains("open_questions"), "error should name the missing key: {err}");
    assert!(err.contains("questions"), "error should list the keys present: {err}");
}

#[test]
fn succeeds_when_the_required_key_is_present_but_its_value_is_empty() {
    // A meeting with genuinely no open questions is valid and must still
    // succeed — the check is for key presence, not non-emptiness.
    let empty = r#"{"open_questions":[]}"#;
    let parsed = parse_pass_fragment(empty, &["open_questions"]).expect("parse");
    assert!(parsed.open_questions.is_empty());
}
