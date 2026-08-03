use super::notes::{generate_notes, parse_pass_fragment};
use async_trait::async_trait;
use meeting_notes_core::summary::SummaryProvider;
use std::sync::Mutex;

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
    let result = generate_notes(&provider, "a short transcript").await.expect("generate");

    assert_eq!(result.meeting_type, "Team sync");
    assert_eq!(result.topics.len(), 1);
    assert_eq!(result.decisions.len(), 1);
    assert_eq!(result.action_items[0].owner.as_deref(), Some("Parker"));
    assert_eq!(result.open_questions, vec!["Who covers chat?".to_string()]);
}

#[tokio::test]
async fn runs_exactly_three_passes_for_a_transcript_that_fits() {
    let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
    generate_notes(&provider, "one two three").await.expect("generate");
    assert_eq!(provider.prompts.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn every_pass_prompt_carries_the_transcript() {
    let provider = ScriptedProvider::new(vec![PASS_A, PASS_B, PASS_C], 1000);
    generate_notes(&provider, "the distinctive transcript body").await.expect("generate");
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
    let result = generate_notes(&provider, "one two three four five six").await.expect("generate");

    assert_eq!(provider.prompts.lock().unwrap().len(), 9);
    // The same canned topic came back for every chunk and must fold to one.
    assert_eq!(result.topics.len(), 1);
    assert_eq!(result.action_items.len(), 1);
}

#[tokio::test]
async fn fails_the_whole_run_when_any_pass_fails() {
    // Partial notes rendered in the standard format would look complete
    // while silently missing a section.
    let result = generate_notes(&FailingProvider, "a transcript").await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("endpoint down"));
}

#[tokio::test]
async fn rejects_an_empty_transcript_before_calling_the_provider() {
    let provider = ScriptedProvider::new(vec![], 1000);
    let result = generate_notes(&provider, "   ").await;
    assert!(result.is_err());
    assert!(provider.prompts.lock().unwrap().is_empty());
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
