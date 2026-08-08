use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

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

/// Runs `pactl subscribe` indefinitely, calling `on_external_mic_activity`
/// once per genuinely-new external mic-capture stream. `seen_ids` prevents
/// re-firing for state-change events on a stream we've already reported —
/// an ongoing Zoom call shouldn't spam the prompt repeatedly.
///
/// `seen_ids` is a plain `HashSet` (not `Arc<Mutex<_>>`): this loop is the
/// only thing that ever touches it, so there is nothing to share across
/// threads. Using a real lock here would previously have been held across
/// `is_external_mic_activity`'s blocking `pactl list source-outputs`
/// subprocess call on every single-threaded iteration -- harmless today
/// (uncontended lock), but a latent footgun if this function ever grew a
/// second caller.
///
/// `on_child_spawned` is invoked once, immediately after the `pactl
/// subscribe` child process is spawned, with its PID -- this is this
/// function's only chance to hand that PID back to the caller, since the
/// rest of this function is a blocking loop over the child's stdout. The
/// caller uses the PID to SIGTERM the child on app shutdown, mirroring the
/// `pw-record` shutdown convention in
/// `crates/meeting-notes-audio/src/linux.rs` -- otherwise the child is
/// reparented to init and keeps running as an orphan after this app exits,
/// since exiting a parent process does not terminate its children on Linux.
pub fn watch_mic_activity(
    on_child_spawned: impl FnOnce(u32) + Send + 'static,
    on_external_mic_activity: impl Fn() + Send + 'static,
) -> std::io::Result<()> {
    let mut child = Command::new("pactl")
        .arg("subscribe")
        .stdout(Stdio::piped())
        .spawn()?;

    on_child_spawned(child.id());

    let stdout = child.stdout.take().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "failed to capture pactl subscribe stdout")
    })?;

    let mut seen_ids: HashSet<u32> = HashSet::new();

    for line in BufReader::new(stdout).lines().filter_map(|l| l.ok()) {
        let Some(event) = parse_subscribe_line(&line) else { continue };

        if seen_ids.contains(&event.id) {
            continue;
        }

        if is_external_mic_activity(event.id) {
            seen_ids.insert(event.id);
            on_external_mic_activity();
        }
    }

    Ok(())
}

#[cfg(test)]
#[path = "mic_watcher_tests.rs"]
mod mic_watcher_tests;
