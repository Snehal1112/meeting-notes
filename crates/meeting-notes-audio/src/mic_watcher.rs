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

#[cfg(test)]
#[path = "mic_watcher_tests.rs"]
mod mic_watcher_tests;
