use crate::meeting::MeetingMeta;
use crate::summary::{SummaryResult, Topic};

/// Fixed preamble explaining the limits of the transcription, so a reader
/// knows why lines are unattributed and why some terms look wrong.
const ASR_CAVEAT: &str = "> Note: this transcript is auto-generated (Whisper ASR) with no \
speaker diarization, so individual lines aren't attributed to named speakers. A few terms \
are likely mis-transcribed and are flagged below with best-guess interpretations.";

/// Renders the notes as the meeting's `summary.md`.
///
/// The title, date and recording length come from `meeting` rather than from
/// the model, so they are always factual. Empty sections are dropped instead
/// of being rendered as bare headings.
pub fn render_summary_markdown(result: &SummaryResult, meeting: &MeetingMeta) -> String {
    let mut out = String::new();

    let title = if meeting.title.trim().is_empty() {
        &meeting.id
    } else {
        &meeting.title
    };
    out.push_str(&format!("# {title}\n\n"));

    // Collect metadata lines and join with hard line breaks (two spaces + newline).
    // The last line gets a single newline to avoid trailing whitespace.
    let mut metadata = Vec::new();

    // created_at is RFC 3339, so the date is the part before the 'T'.
    let date = meeting.created_at.split('T').next().unwrap_or("");
    metadata.push(format!("**Date:** {date}"));

    if !result.meeting_type.trim().is_empty() {
        metadata.push(format!("**Type:** {}", result.meeting_type));
    }

    if !result.attendees.is_empty() {
        let mut attendees = format!("**Attendees mentioned:** {}", result.attendees.join(", "));
        if !result.referenced_people.is_empty() {
            attendees.push_str(&format!(
                " (referenced but not confirmed on the call: {})",
                result.referenced_people.join(", ")
            ));
        }
        metadata.push(attendees);
    }

    if let Some(seconds) = meeting.duration_seconds {
        let minutes = (seconds as f64 / 60.0).round() as i64;
        metadata.push(format!("**Recording length:** ~{minutes} minutes"));
    }

    out.push_str(&metadata.join("  \n"));
    out.push('\n');

    out.push_str(&format!("\n{ASR_CAVEAT}\n"));

    if !result.summary.trim().is_empty() {
        out.push_str(&format!("\n## Summary\n{}\n", result.summary));
    }

    // A topic with no points would render as a bare "### <title>" heading
    // with nothing under it, which is the empty section the spec forbids —
    // so topics are filtered down to ones with content before rendering.
    // If that leaves none at all, the "## Discussion Notes" heading itself
    // must not appear either.
    let topics_with_points: Vec<&Topic> =
        result.topics.iter().filter(|topic| !topic.points.is_empty()).collect();
    if !topics_with_points.is_empty() {
        out.push_str("\n## Discussion Notes\n");
        for topic in topics_with_points {
            out.push_str(&format!("\n### {}\n", topic.title));
            for point in &topic.points {
                out.push_str(&format!("- {point}\n"));
            }
        }
    }

    push_bullet_section(&mut out, "Decisions", &result.decisions);

    if !result.action_items.is_empty() {
        out.push_str("\n## Action Items\n");
        for item in &result.action_items {
            match &item.owner {
                Some(owner) if !owner.trim().is_empty() => {
                    out.push_str(&format!("- [ ] {} — {}\n", item.text, owner))
                }
                _ => out.push_str(&format!("- [ ] {}\n", item.text)),
            }
        }
    }

    push_bullet_section(&mut out, "Open Questions", &result.open_questions);

    out
}

/// Appends a `## <title>` section of plain bullets, or nothing at all when
/// there is no content for it.
fn push_bullet_section(out: &mut String, title: &str, items: &[String]) {
    if items.is_empty() {
        return;
    }
    out.push_str(&format!("\n## {title}\n"));
    for item in items {
        out.push_str(&format!("- {item}\n"));
    }
}
