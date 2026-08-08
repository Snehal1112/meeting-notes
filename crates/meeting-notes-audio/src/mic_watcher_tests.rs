use super::*;

#[test]
fn parses_new_source_output_event() {
    let line = "Event 'new' on source-output #42";
    assert_eq!(parse_subscribe_line(line), Some(SourceOutputEvent { id: 42 }));
}

#[test]
fn ignores_unrelated_event_lines() {
    let line = "Event 'change' on sink #3";
    assert_eq!(parse_subscribe_line(line), None);
}

#[test]
fn ignores_source_output_remove_events() {
    // Only "new" matters here — a stream ending isn't "mic activity starting."
    let line = "Event 'remove' on source-output #42";
    assert_eq!(parse_subscribe_line(line), None);
}

#[test]
fn is_own_recording_detects_pw_record_process_name() {
    let details = "application.process.binary = \"pw-record\"\napplication.name = \"pw-record\"";
    assert!(is_own_recording(details));
}

#[test]
fn is_own_recording_false_for_other_processes() {
    let details = "application.process.binary = \"zoom\"\napplication.name = \"Zoom Meeting\"";
    assert!(!is_own_recording(details));
}

#[test]
fn is_mic_capture_true_for_real_input_source() {
    let details = "source: alsa_input.pci-0000_00_1f.3.analog-stereo\nmedia.class = \"Stream/Input/Audio\"";
    assert!(is_mic_capture(details));
}

#[test]
fn is_mic_capture_false_for_monitor_source_tap() {
    // System-audio monitoring (e.g. this app's own system-audio capture, or
    // an audio visualizer) taps a `.monitor` source, not the mic itself —
    // shouldn't count as "someone is using the mic."
    let details = "source: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor\nmedia.class = \"Stream/Input/Audio\"";
    assert!(!is_mic_capture(details));
}
