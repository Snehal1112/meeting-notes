use super::*;

#[test]
#[ignore = "requires real PipeWire/wpctl with an active sink on the dev machine"]
fn detects_a_default_sink_when_present() {
    let result = find_default_sink_id();
    // On a normal desktop with an active sink, this should find something.
    assert!(result.is_some(), "expected a default sink id to be found");
}

/// A "Sinks:" section with one `*`-marked line should yield that line's id,
/// shaped from real `wpctl status` output captured on the dev machine (see
/// docs/superpowers/specs/environment.md, "Task 2: PipeWire audio capture").
#[test]
fn parse_default_sink_id_finds_marked_sink() {
    let fixture = "\
Audio
 ├─ Devices:
 │      52. Family 17h/19h HD Audio Controller  [alsa]
 │
 ├─ Sinks:
 │  *   40. Family 17h/19h HD Audio Controller Speaker + Headphones [vol: 1.53]
 │      63. Rembrandt Radeon High Definition Audio Controller HDMI / DisplayPort 2 Output [vol: 0.40]
 │
 ├─ Sink endpoints:
 │
 ├─ Sources:
 │  *   36. Digital Microphone (DC-blocked)     [vol: 1.00]
 │      62. Family 17h/19h HD Audio Controller Digital Microphone [vol: 1.00]
 │
 └─ Streams:
";
    assert_eq!(parse_default_sink_id(fixture), Some(40));
}

/// A "Sinks:" section where no line is marked `*` (e.g. between devices
/// switching) must return None rather than picking an arbitrary sink or
/// falling through to a `*`-marked line in a later section like "Sources:".
#[test]
fn parse_default_sink_id_returns_none_when_no_sink_marked() {
    let fixture = "\
Audio
 ├─ Sinks:
 │      40. Family 17h/19h HD Audio Controller Speaker + Headphones [vol: 1.53]
 │      63. Rembrandt Radeon High Definition Audio Controller HDMI / DisplayPort 2 Output [vol: 0.40]
 │
 ├─ Sources:
 │  *   36. Digital Microphone (DC-blocked)     [vol: 1.00]
 │
 └─ Streams:
";
    assert_eq!(parse_default_sink_id(fixture), None);
}

/// Empty input, or input with no "Sinks:" section at all, must return None
/// rather than panicking.
#[test]
fn parse_default_sink_id_returns_none_for_empty_or_no_sinks_section() {
    assert_eq!(parse_default_sink_id(""), None);

    let fixture = "\
Audio
 ├─ Devices:
 │      52. Family 17h/19h HD Audio Controller  [alsa]
";
    assert_eq!(parse_default_sink_id(fixture), None);
}

#[test]
#[ignore = "requires a real PipeWire mic source; run manually with `cargo test -- --ignored` on hardware"]
fn start_creates_output_file_after_stop() {
    let tmp = std::env::temp_dir().join(format!("mic-test-{}.wav", std::process::id()));
    let (mut handle, used_system_audio) =
        RecordingHandle::start(&tmp).expect("should start recording");
    println!("used_system_audio = {used_system_audio}");
    std::thread::sleep(std::time::Duration::from_millis(500));
    handle.stop().expect("should stop cleanly");
    assert!(tmp.exists(), "expected wav file to exist at {:?}", tmp);
    let _ = std::fs::remove_file(&tmp);
}
