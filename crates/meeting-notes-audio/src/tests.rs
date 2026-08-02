use super::*;

#[test]
#[ignore = "requires real PipeWire/wpctl with an active sink on the dev machine"]
fn detects_a_monitor_source_when_present() {
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
    let mut handle = RecordingHandle::start_mic(&tmp).expect("should start recording");
    std::thread::sleep(std::time::Duration::from_millis(500));
    handle.stop().expect("should stop cleanly");
    assert!(tmp.exists(), "expected wav file to exist at {:?}", tmp);
    let _ = std::fs::remove_file(&tmp);
}

/// A buffer shorter than the trim window (500ms at 16kHz = 8000 samples) must
/// not panic, and should skip both trimming and the quality check entirely.
#[test]
fn analyze_and_trim_short_buffer_keeps_all_samples() {
    let sample_rate = 16_000;
    let samples: Vec<i16> = vec![100, -100, 200, -200]; // far fewer than 8000
    let (trimmed, warning) = analyze_and_trim(&samples, sample_rate);
    assert_eq!(trimmed, samples);
    assert!(warning.is_none(), "expected no warning, got {:?}", warning);
}

/// A buffer with near-zero DC offset and no clipping should pass the quality
/// check, and the trimmed length should equal original_len - trim_count.
#[test]
fn analyze_and_trim_clean_signal_passes_and_trims() {
    let sample_rate = 16_000;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let total_len = trim_count + 4000;

    // Alternating-sign pattern: near-zero mean, no clipping.
    let samples: Vec<i16> = (0..total_len)
        .map(|i| if i % 2 == 0 { 500 } else { -500 })
        .collect();

    let (trimmed, warning) = analyze_and_trim(&samples, sample_rate);
    assert!(warning.is_none(), "expected no warning, got {:?}", warning);
    assert_eq!(trimmed.len(), total_len - trim_count);
    assert_eq!(trimmed, samples[trim_count..]);
}

/// A buffer with a large constant DC offset should be flagged as a likely mic fault.
#[test]
fn analyze_and_trim_large_dc_offset_is_flagged() {
    let sample_rate = 16_000;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let total_len = trim_count + 4000;

    let samples: Vec<i16> = vec![5000; total_len];

    let (_trimmed, warning) = analyze_and_trim(&samples, sample_rate);
    match warning {
        Some(QualityWarning { dc_offset_mean, .. }) => {
            assert!((dc_offset_mean - 5000.0).abs() < 0.01);
        }
        other => panic!("expected Some(QualityWarning), got {:?}", other),
    }
}

/// A buffer where a large fraction of samples clip should be flagged as a
/// likely mic fault even when the mean is near zero — this specifically
/// tests that clipping is caught independently of the DC-offset check.
#[test]
fn analyze_and_trim_clipping_is_flagged_independently_of_dc_offset() {
    let sample_rate = 16_000;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let total_len = trim_count + 4000;

    // Alternating +32000/-32000: averages near zero but clips heavily.
    let samples: Vec<i16> = (0..total_len)
        .map(|i| if i % 2 == 0 { 32000 } else { -32000 })
        .collect();

    let (_trimmed, warning) = analyze_and_trim(&samples, sample_rate);
    match warning {
        Some(QualityWarning {
            dc_offset_mean,
            clipping_ratio,
        }) => {
            assert!(
                dc_offset_mean.abs() <= DC_OFFSET_THRESHOLD,
                "expected near-zero dc offset, got {dc_offset_mean}"
            );
            assert!(
                clipping_ratio > CLIPPING_RATIO_THRESHOLD,
                "expected high clipping ratio, got {clipping_ratio}"
            );
        }
        other => panic!("expected Some(QualityWarning), got {:?}", other),
    }
}

/// Exercises the real read-WAV -> analyze -> rewrite-WAV sequence used by
/// `stop()`, without needing `pw-record` or real mic hardware: synthesizes a
/// WAV file on disk via `hound::WavWriter`, then calls `trim_and_check_file`
/// directly on it.
#[test]
fn trim_and_check_file_rewrites_wav_and_flags_dc_offset() {
    let sample_rate = 16_000u32;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let post_trim_len = 4000usize;
    let total_len = trim_count + post_trim_len;

    // Leading (pre-trim) window: heavy clipping, which must be discarded by
    // the trim and therefore must NOT influence the returned warning.
    let leading: Vec<i16> = vec![32000; trim_count];
    // Trailing (post-trim) window: a large constant DC offset, no clipping.
    let trailing: Vec<i16> = vec![5000; post_trim_len];

    let samples: Vec<i16> = leading.into_iter().chain(trailing).collect();
    assert_eq!(samples.len(), total_len);

    let tmp = std::env::temp_dir().join(format!(
        "trim-and-check-test-{}-{}.wav",
        std::process::id(),
        line!()
    ));

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    {
        let mut writer = hound::WavWriter::create(&tmp, spec).expect("should create wav");
        for sample in &samples {
            writer.write_sample(*sample).expect("should write sample");
        }
        writer.finalize().expect("should finalize wav");
    }

    let warning = trim_and_check_file(&tmp).expect("should trim and check file");

    match &warning {
        Some(QualityWarning { dc_offset_mean, .. }) => {
            assert!(
                (dc_offset_mean - 5000.0).abs() < 0.01,
                "expected dc_offset_mean ~5000 from post-trim samples only, got {dc_offset_mean}"
            );
        }
        None => panic!("expected Some(QualityWarning) from the DC-offset trailing window"),
    }

    // (a) rewritten file's sample count matches the expected post-trim count.
    // (c) file is still valid enough for WavReader::open to succeed.
    let mut reader = hound::WavReader::open(&tmp).expect("rewritten wav should still open");
    let rewritten: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<Vec<i16>, hound::Error>>()
        .expect("rewritten wav samples should be readable");
    assert_eq!(rewritten.len(), post_trim_len);
    assert_eq!(rewritten, vec![5000i16; post_trim_len]);

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn mixes_two_equal_length_wavs() {
    let dir = std::env::temp_dir().join(format!("mix-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.wav");
    let b = dir.join("b.wav");
    write_test_wav(&a, &[1000, 2000, 3000]);
    write_test_wav(&b, &[500, 500, 500]);
    let out = dir.join("mixed.wav");

    mix_wav_files(&a, &b, &out).expect("mix should succeed");

    let mut reader = hound::WavReader::open(&out).unwrap();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(samples, vec![1500, 2500, 3500]);

    let _ = std::fs::remove_dir_all(&dir);
}

/// When the two inputs differ in length, the output must match the longer
/// input's length, and the trailing samples (past the shorter input's end)
/// must equal the longer input's own values unchanged, since the missing
/// side contributes silence (0).
#[test]
fn mixes_unequal_length_wavs_treating_missing_samples_as_silence() {
    let dir = std::env::temp_dir().join(format!("mix-test-unequal-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.wav");
    let b = dir.join("b.wav");
    write_test_wav(&a, &[1000, 2000, 3000]);
    write_test_wav(&b, &[100, 200, 300, 400, 500]);
    let out = dir.join("mixed.wav");

    mix_wav_files(&a, &b, &out).expect("mix should succeed");

    let mut reader = hound::WavReader::open(&out).unwrap();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(samples.len(), 5, "output length should match the longer input");
    assert_eq!(samples[..3], [1100, 2200, 3300]);
    // Trailing samples: a's stream has ended (treated as 0), so these equal
    // b's own values unchanged.
    assert_eq!(samples[3..], [400, 500]);

    let _ = std::fs::remove_dir_all(&dir);
}

fn write_test_wav(path: &std::path::Path, samples: &[i16]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for s in samples {
        writer.write_sample(*s).unwrap();
    }
    writer.finalize().unwrap();
}
