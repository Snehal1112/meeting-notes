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

#[test]
fn extract_source_output_block_anchors_id_to_avoid_prefix_collision() {
    // Regression test for the ID-prefix collision bug: looking up #4 must not
    // match inside #42. This test confirms the newline anchor prevents the collision.
    let pactl_output = "Source Output #4\n\tproperty = value\n\tsource: alsa_input.pci-0000_00_1f.3.analog-stereo\n\nmedia.class = Stream/Input/Audio\n\nSource Output #42\n\tproperty = value\n\tsource: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor\n\nmedia.class = Stream/Input/Audio\n";

    // Looking up #4 should return only the #4 block, not the #42 block.
    let result = extract_source_output_block(&pactl_output, 4);
    assert!(result.is_some());
    let block = result.unwrap();
    assert!(block.contains("Source Output #4"));
    assert!(!block.contains("Source Output #42"));

    // Looking up #42 should return only the #42 block.
    let result = extract_source_output_block(&pactl_output, 42);
    assert!(result.is_some());
    let block = result.unwrap();
    assert!(block.contains("Source Output #42"));
    assert!(!block.contains("property = value\n\tsource: alsa_input")); // The first block's source line.

    // Looking up a non-existent #7 should return None.
    let result = extract_source_output_block(&pactl_output, 7);
    assert!(result.is_none());
}
