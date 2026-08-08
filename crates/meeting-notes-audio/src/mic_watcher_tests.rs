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

// The fixtures below are trimmed `Properties:` excerpts captured from real
// `pactl list source-outputs` output on a PipeWire/pipewire-pulse system
// (Ubuntu, pactl 16.1), not hand-written approximations -- see the finding
// this replaces: the previous fixtures used a `source: <name>` line and a
// `.monitor`-suffix check that never appear in real pactl output at all
// (the real field is `Source: <numeric id>`, capitalized, with no name),
// which is how the `is_mic_capture` bug passed review undetected. Captured
// via:
//   parec --raw -d "$(pactl get-default-source)" >/dev/null &   # real mic capture
//   parec --raw -d "<sink>.monitor" >/dev/null &                 # monitor tap
//   pw-record --target "$(pactl get-default-source)" out.wav &   # real pw-record capture
// then `pactl list source-outputs` while each was running.

#[test]
fn is_own_recording_detects_pw_record_process_name() {
    // Real pw-record output does not set `application.process.binary` at
    // all (unlike parec/pacat, which goes through the pipewire-pulse
    // compatibility layer) -- only `application.name` and `node.name`. The
    // old fixture asserted a property real pw-record never emits.
    let details = "\t\tapplication.name = \"pw-record\"\n\t\tnode.name = \"pw-record\"\n\t\tmedia.type = \"Audio\"\n\t\tmedia.category = \"Capture\"\n\t\tmedia.class = \"Stream/Input/Audio\"";
    assert!(is_own_recording(details));
}

#[test]
fn is_own_recording_false_for_other_processes() {
    // Real capture from `parec` (a third-party-app stand-in): pipewire-pulse
    // reports its process binary as "pacat" (parec's compatibility shim),
    // distinct from this app's own "pw-record" captures.
    let details = "\t\tclient.api = \"pipewire-pulse\"\n\t\tapplication.name = \"parec\"\n\t\tapplication.process.binary = \"pacat\"\n\t\tmedia.class = \"Stream/Input/Audio\"";
    assert!(!is_own_recording(details));
}

#[test]
fn is_mic_capture_true_for_real_input_source() {
    // Real `parec -d $(pactl get-default-source)` capture: a genuine mic
    // stream. No `stream.capture.sink` property at all -- that only appears
    // on monitor-source taps (see below).
    let details = "\t\tclient.api = \"pipewire-pulse\"\n\t\tapplication.name = \"parec\"\n\t\tapplication.process.binary = \"pacat\"\n\t\ttarget.object = \"dcblock_dmic\"\n\t\tstream.is-live = \"true\"\n\t\tnode.name = \"parec\"\n\t\tmedia.class = \"Stream/Input/Audio\"";
    assert!(is_mic_capture(details));
}

#[test]
fn is_mic_capture_false_for_monitor_source_tap() {
    // Real `parec -d <sink>.monitor` capture (system-audio monitoring, e.g.
    // this app's own system-audio capture, or an audio visualizer). PipeWire
    // marks these with `stream.capture.sink = "true"` -- the actual
    // discriminator, unrelated to source *naming* (there is no source name
    // in real pactl output at all; the field is a numeric `Source: <id>`).
    let details = "\t\tclient.api = \"pipewire-pulse\"\n\t\tapplication.name = \"parec\"\n\t\tapplication.process.binary = \"pacat\"\n\t\ttarget.object = \"alsa_output.pci-0000_64_00.6.HiFi__hw_Generic_1__sink\"\n\t\tstream.capture.sink = \"true\"\n\t\tstream.is-live = \"true\"\n\t\tnode.name = \"parec\"\n\t\tmedia.class = \"Stream/Input/Audio\"";
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

#[test]
fn parse_source_output_ids_finds_every_header_in_order() {
    // Regression coverage for the startup scan added to watch_mic_activity:
    // it needs every currently-active source-output id, not just one, since
    // multiple streams (this app's own pw-record capture, a genuine mic
    // stream, a monitor tap) can all be active simultaneously when the
    // widget launches mid-call.
    let pactl_output = "Source Output #34\n\tProperties:\n\t\tnode.name = \"capture.dcblock_dmic\"\n\nSource Output #352\n\tProperties:\n\t\tapplication.name = \"parec\"\n\nSource Output #406\n\tProperties:\n\t\tapplication.name = \"pw-record\"\n";

    assert_eq!(parse_source_output_ids(pactl_output), vec![34, 352, 406]);
}

#[test]
fn parse_source_output_ids_empty_for_no_streams() {
    // `pactl list source-outputs` prints nothing when no streams are active
    // -- the startup scan must treat that as "nothing to seed," not error.
    assert_eq!(parse_source_output_ids(""), Vec::<u32>::new());
}
