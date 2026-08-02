use super::summary::{ActionItem, SummaryResult, Topic};

fn sample() -> SummaryResult {
    SummaryResult {
        meeting_type: "Team sync - Q3 planning".to_string(),
        attendees: vec!["Parker".to_string()],
        referenced_people: vec!["Craig".to_string()],
        summary: "The team reviewed Q3 plans.".to_string(),
        topics: vec![Topic {
            title: "Q3 OKRs".to_string(),
            points: vec!["Events grew from 8 to 18.".to_string()],
        }],
        decisions: vec!["Assignments stay self-managed.".to_string()],
        action_items: vec![ActionItem {
            text: "Grab a booth slot".to_string(),
            owner: Some("Parker".to_string()),
        }],
        open_questions: vec!["Who covers the time-zone gap?".to_string()],
    }
}

#[test]
fn summary_result_round_trips_through_json() {
    let json = serde_json::to_string(&sample()).expect("serialize");
    let back: SummaryResult = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back.topics[0].title, "Q3 OKRs");
    assert_eq!(back.action_items[0].owner.as_deref(), Some("Parker"));
    assert_eq!(back.open_questions.len(), 1);
}

#[test]
fn action_item_owner_is_optional() {
    let raw = r#"{"text": "Book the room", "owner": null}"#;
    let item: ActionItem = serde_json::from_str(raw).expect("deserialize");
    assert_eq!(item.owner, None);
}

#[test]
fn action_item_owner_defaults_to_none_when_the_model_omits_it() {
    // Models drop null fields often enough that a missing key must not be a
    // parse error.
    let raw = r#"{"text": "Book the room"}"#;
    let item: ActionItem = serde_json::from_str(raw).expect("deserialize");
    assert_eq!(item.owner, None);
}

#[test]
fn list_fields_default_to_empty_when_the_model_omits_them() {
    // A pass returns only its own fields, so every other list must default.
    let raw = r#"{"summary": "Short meeting."}"#;
    let result: SummaryResult = serde_json::from_str(raw).expect("deserialize");
    assert_eq!(result.summary, "Short meeting.");
    assert!(result.topics.is_empty());
    assert!(result.action_items.is_empty());
    assert_eq!(result.meeting_type, "");
}
