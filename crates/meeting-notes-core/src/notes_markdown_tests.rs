use super::meeting::{MeetingMeta, MeetingStatus};
use super::notes_markdown::render_summary_markdown;
use super::summary::{ActionItem, SummaryResult, Topic};

fn meeting() -> MeetingMeta {
    MeetingMeta {
        id: "2026-08-02_161819_product-marketing".to_string(),
        title: "Product Marketing Team Sync".to_string(),
        created_at: "2026-08-02T16:18:19Z".to_string(),
        duration_seconds: Some(725),
        status: MeetingStatus::Done,
        used_system_audio: true,
    }
}

fn full_result() -> SummaryResult {
    SummaryResult {
        meeting_type: "Team sync - Commit planning".to_string(),
        attendees: vec!["Parker".to_string(), "Cindy".to_string()],
        referenced_people: vec!["Craig".to_string()],
        summary: "The team covered Commit staffing and Q3 OKRs.".to_string(),
        topics: vec![Topic {
            title: "Commit conference coverage".to_string(),
            points: vec!["Parker still needs a booth slot.".to_string()],
        }],
        decisions: vec!["Cormac and Cindy are recused.".to_string()],
        action_items: vec![
            ActionItem { text: "Grab a booth slot".to_string(), owner: Some("Parker".to_string()) },
            ActionItem { text: "Create a duties checklist".to_string(), owner: None },
        ],
        open_questions: vec!["Who covers the time-zone gap?".to_string()],
    }
}

#[test]
fn renders_every_section_in_the_reference_order() {
    let md = render_summary_markdown(&full_result(), &meeting());

    let order = [
        "# Product Marketing Team Sync",
        "**Date:** 2026-08-02",
        "**Type:** Team sync - Commit planning",
        "## Summary",
        "## Discussion Notes",
        "### Commit conference coverage",
        "## Decisions",
        "## Action Items",
        "## Open Questions",
    ];
    let mut cursor = 0;
    for marker in order {
        let at = md[cursor..]
            .find(marker)
            .unwrap_or_else(|| panic!("missing or out of order: {marker}\n---\n{md}"));
        cursor += at + marker.len();
    }
}

#[test]
fn renders_attendees_with_the_referenced_clause() {
    let md = render_summary_markdown(&full_result(), &meeting());
    assert!(md.contains(
        "**Attendees mentioned:** Parker, Cindy (referenced but not confirmed on the call: Craig)"
    ));
}

#[test]
fn omits_the_referenced_clause_when_no_one_was_only_referenced() {
    let mut result = full_result();
    result.referenced_people.clear();
    let md = render_summary_markdown(&result, &meeting());
    assert!(md.contains("**Attendees mentioned:** Parker, Cindy"));
    assert!(!md.contains("referenced but not confirmed"));
}

#[test]
fn rounds_the_recording_length_to_whole_minutes() {
    let md = render_summary_markdown(&full_result(), &meeting());
    assert!(md.contains("**Recording length:** ~12 minutes"), "got:\n{md}");
}

#[test]
fn omits_the_recording_length_when_the_duration_is_unknown() {
    // An interrupted recording never records a duration. "~0 minutes" would
    // be worse than saying nothing.
    let mut m = meeting();
    m.duration_seconds = None;
    let md = render_summary_markdown(&full_result(), &m);
    assert!(!md.contains("Recording length"));
}

#[test]
fn includes_the_asr_caveat() {
    let md = render_summary_markdown(&full_result(), &meeting());
    assert!(md.contains("> Note: this transcript is auto-generated (Whisper ASR)"));
}

#[test]
fn renders_action_items_as_checkboxes_with_the_owner_when_known() {
    let md = render_summary_markdown(&full_result(), &meeting());
    assert!(md.contains("- [ ] Grab a booth slot — Parker"));
    assert!(md.contains("- [ ] Create a duties checklist\n"));
}

#[test]
fn omits_empty_sections_entirely() {
    let mut result = full_result();
    result.decisions.clear();
    result.open_questions.clear();
    let md = render_summary_markdown(&result, &meeting());
    assert!(!md.contains("## Decisions"));
    assert!(!md.contains("## Open Questions"));
    assert!(md.contains("## Action Items"));
}

#[test]
fn falls_back_to_the_meeting_id_when_the_recording_has_no_title() {
    let mut m = meeting();
    m.title = String::new();
    let md = render_summary_markdown(&full_result(), &m);
    assert!(md.starts_with("# 2026-08-02_161819_product-marketing"));
}

#[test]
fn takes_the_date_from_the_meeting_not_the_model() {
    let md = render_summary_markdown(&full_result(), &meeting());
    assert!(md.contains("**Date:** 2026-08-02"));
}
