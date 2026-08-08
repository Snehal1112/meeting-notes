use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub struct SourceOutputEvent {
    pub id: u32,
}

/// Parses one line of `pactl subscribe` output. Only "new source-output"
/// events matter here — that's what fires the instant an application opens
/// a capture stream from any source (including the mic).
pub fn parse_subscribe_line(line: &str) -> Option<SourceOutputEvent> {
    if !line.contains("'new'") || !line.contains("source-output") {
        return None;
    }
    let id_str = line.rsplit('#').next()?;
    let id = id_str.trim().parse().ok()?;
    Some(SourceOutputEvent { id })
}

pub fn is_own_recording(details: &str) -> bool {
    details.contains("pw-record")
}

pub fn is_mic_capture(details: &str) -> bool {
    details.contains("source:") && !details.contains(".monitor")
}

/// Extracts the source output block for a given ID from pactl text output.
/// Returns None if the ID is not found. Anchors the marker with a newline
/// to avoid ID-prefix collisions (e.g., looking up #4 must not match inside #42).
/// This is a pure function for testability (doesn't call pactl itself).
pub fn extract_source_output_block(text: &str, id: u32) -> Option<String> {
    // Anchor to newline to prevent "#4" matching inside "#42".
    let marker = format!("Source Output #{id}\n");
    let block_start = text.find(&marker)?;
    let rest = &text[block_start..];
    let block_end = rest[1..].find("Source Output #").map(|i| i + 1).unwrap_or(rest.len());
    Some(rest[..block_end].to_string())
}

/// Fetches `pactl list source-outputs` and returns the block of text for
/// the given stream id, if it still exists (streams can end between the
/// "new" event firing and this lookup running — treat that as "nothing to
/// report" rather than an error).
pub fn fetch_source_output_details(id: u32) -> Option<String> {
    let output = Command::new("pactl")
        .args(["list", "source-outputs"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    extract_source_output_block(&text, id)
}

/// The combined check this task exists for: is this event genuinely
/// "someone else started using the mic," as opposed to this app's own
/// recording or an unrelated monitor-source tap.
pub fn is_external_mic_activity(id: u32) -> bool {
    match fetch_source_output_details(id) {
        Some(details) => is_mic_capture(&details) && !is_own_recording(&details),
        None => false,
    }
}

#[cfg(test)]
#[path = "mic_watcher_tests.rs"]
mod mic_watcher_tests;
