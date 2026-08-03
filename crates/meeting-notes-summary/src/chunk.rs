use meeting_notes_core::summary::{SummaryResult, Topic};

/// Splits `transcript` into pieces of at most `max_words` words.
///
/// Splitting on whitespace is deliberately crude: the transcript is a single
/// unpunctuated block of speech-to-text with no reliable sentence or speaker
/// boundaries to split on, so a word budget is the only honest unit.
pub fn split_transcript(transcript: &str, max_words: usize) -> Vec<String> {
    let words: Vec<&str> = transcript.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    // A zero budget would make chunks() panic, so treat it as "everything in
    // one chunk" rather than letting a bad config crash the summarize flow.
    if max_words == 0 {
        return vec![words.join(" ")];
    }
    words.chunks(max_words).map(|c| c.join(" ")).collect()
}

/// Combines per-chunk notes into one set.
///
/// This is deliberately deterministic rather than another model call: the
/// merge is the step most likely to silently drop content, and pure Rust can
/// be tested exhaustively.
pub fn merge_partials(partials: Vec<SummaryResult>) -> SummaryResult {
    let mut merged = SummaryResult::default();
    let mut summaries: Vec<String> = Vec::new();

    for partial in partials {
        if merged.meeting_type.is_empty() && !partial.meeting_type.trim().is_empty() {
            merged.meeting_type = partial.meeting_type;
        }
        if !partial.summary.trim().is_empty() {
            summaries.push(partial.summary);
        }

        push_unique(&mut merged.attendees, partial.attendees);
        push_unique(&mut merged.referenced_people, partial.referenced_people);
        push_unique(&mut merged.decisions, partial.decisions);
        push_unique(&mut merged.open_questions, partial.open_questions);

        for topic in partial.topics {
            merge_topic(&mut merged.topics, topic);
        }

        for item in partial.action_items {
            let duplicate = merged
                .action_items
                .iter()
                .any(|existing| existing.text.eq_ignore_ascii_case(&item.text));
            if !duplicate {
                merged.action_items.push(item);
            }
        }
    }

    merged.summary = summaries.join(" ");

    // A model's attendee/referenced judgement is inconsistent across passes
    // and chunks, so the same person can land in both lists — e.g. chunk 1
    // places them in attendees, chunk 2 in referenced_people. Attendee is the
    // stronger claim, so it wins; otherwise the header renders the
    // self-contradictory "referenced but not confirmed on the call: X" for
    // someone already listed as confirmed.
    merged.referenced_people.retain(|referenced| {
        !merged
            .attendees
            .iter()
            .any(|attendee| attendee.eq_ignore_ascii_case(referenced))
    });

    merged
}

/// Folds `topic` into `topics`, appending its points to an existing entry
/// when the same subject was discussed either side of a chunk boundary.
fn merge_topic(topics: &mut Vec<Topic>, topic: Topic) {
    if let Some(existing) = topics
        .iter_mut()
        .find(|t| t.title.eq_ignore_ascii_case(&topic.title))
    {
        push_unique(&mut existing.points, topic.points);
    } else {
        topics.push(topic);
    }
}

/// Appends the entries of `incoming` not already present, ignoring case.
fn push_unique(target: &mut Vec<String>, incoming: Vec<String>) {
    for value in incoming {
        if !target.iter().any(|existing| existing.eq_ignore_ascii_case(&value)) {
            target.push(value);
        }
    }
}
