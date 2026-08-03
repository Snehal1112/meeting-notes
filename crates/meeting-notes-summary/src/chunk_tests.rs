use super::chunk::{merge_partials, split_transcript};
use meeting_notes_core::summary::{ActionItem, SummaryResult, Topic};

#[test]
fn returns_a_single_chunk_when_the_transcript_fits() {
    let chunks = split_transcript("one two three", 10);
    assert_eq!(chunks, vec!["one two three".to_string()]);
}

#[test]
fn splits_on_the_word_budget() {
    let transcript = (1..=10).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
    let chunks = split_transcript(&transcript, 4);
    assert_eq!(chunks, vec!["1 2 3 4", "5 6 7 8", "9 10"]);
}

#[test]
fn splits_evenly_when_the_length_is_an_exact_multiple() {
    let transcript = (1..=6).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
    let chunks = split_transcript(&transcript, 3);
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[1], "4 5 6");
}

#[test]
fn returns_no_chunks_for_an_empty_transcript() {
    assert!(split_transcript("   ", 10).is_empty());
}

#[test]
fn treats_a_zero_budget_as_one_chunk_rather_than_looping_forever() {
    // A misconfigured budget must not hang the app.
    let chunks = split_transcript("one two three", 0);
    assert_eq!(chunks.len(), 1);
}

fn partial(topic: &str, point: &str, action: &str) -> SummaryResult {
    SummaryResult {
        topics: vec![Topic { title: topic.to_string(), points: vec![point.to_string()] }],
        action_items: vec![ActionItem { text: action.to_string(), owner: None }],
        ..SummaryResult::default()
    }
}

#[test]
fn merge_concatenates_topics_from_every_partial() {
    let merged = merge_partials(vec![
        partial("Commit", "Parker needs a slot.", "Grab a slot"),
        partial("Q3 OKRs", "Events grew to 18.", "Call Ryan"),
    ]);
    assert_eq!(merged.topics.len(), 2);
    assert_eq!(merged.topics[0].title, "Commit");
    assert_eq!(merged.topics[1].title, "Q3 OKRs");
}

#[test]
fn merge_folds_repeated_topic_titles_into_one_topic() {
    // A subject discussed across a chunk boundary appears in both partials.
    let merged = merge_partials(vec![
        partial("Commit", "Parker needs a slot.", "a"),
        partial("Commit", "Alita needs slots too.", "b"),
    ]);
    assert_eq!(merged.topics.len(), 1);
    assert_eq!(merged.topics[0].points.len(), 2);
}

#[test]
fn merge_matches_topic_titles_case_insensitively() {
    let merged = merge_partials(vec![
        partial("Commit coverage", "one", "a"),
        partial("commit coverage", "two", "b"),
    ]);
    assert_eq!(merged.topics.len(), 1);
}

#[test]
fn merge_deduplicates_identical_action_items() {
    let merged = merge_partials(vec![
        partial("t", "p", "Grab a booth slot"),
        partial("t", "p", "Grab a booth slot"),
    ]);
    assert_eq!(merged.action_items.len(), 1);
}

#[test]
fn merge_deduplicates_identical_points_within_a_topic() {
    let merged = merge_partials(vec![
        partial("Commit", "Parker needs a slot.", "a"),
        partial("Commit", "Parker needs a slot.", "b"),
    ]);
    assert_eq!(merged.topics[0].points.len(), 1);
}

#[test]
fn merge_deduplicates_decisions_questions_and_people() {
    let mut a = SummaryResult::default();
    a.decisions = vec!["Recuse Cormac".to_string()];
    a.open_questions = vec!["Who covers chat?".to_string()];
    a.attendees = vec!["Parker".to_string()];
    let b = a.clone();

    let merged = merge_partials(vec![a, b]);
    assert_eq!(merged.decisions.len(), 1);
    assert_eq!(merged.open_questions.len(), 1);
    assert_eq!(merged.attendees.len(), 1);
}

#[test]
fn merge_keeps_the_first_non_empty_meeting_type() {
    let mut a = SummaryResult::default();
    let mut b = SummaryResult::default();
    b.meeting_type = "Team sync".to_string();
    let merged = merge_partials(vec![a.clone(), b]);
    assert_eq!(merged.meeting_type, "Team sync");

    a.meeting_type = "Standup".to_string();
    let merged = merge_partials(vec![a, SummaryResult::default()]);
    assert_eq!(merged.meeting_type, "Standup");
}

#[test]
fn merge_joins_summaries_from_every_partial() {
    let mut a = SummaryResult::default();
    a.summary = "First half.".to_string();
    let mut b = SummaryResult::default();
    b.summary = "Second half.".to_string();
    let merged = merge_partials(vec![a, b]);
    assert!(merged.summary.contains("First half."));
    assert!(merged.summary.contains("Second half."));
}

#[test]
fn merge_of_nothing_is_an_empty_result() {
    let merged = merge_partials(vec![]);
    assert!(merged.topics.is_empty());
    assert_eq!(merged.summary, "");
}
