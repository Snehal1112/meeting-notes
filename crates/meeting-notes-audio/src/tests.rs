use super::*;

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
    let (trimmed, verdict) = analyze_and_trim(&samples, sample_rate);
    assert_eq!(trimmed, samples);
    assert!(verdict.is_ok(), "expected Ok verdict, got {:?}", verdict);
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

    let (trimmed, verdict) = analyze_and_trim(&samples, sample_rate);
    assert!(verdict.is_ok(), "expected Ok verdict, got {:?}", verdict);
    assert_eq!(trimmed.len(), total_len - trim_count);
}

/// A buffer with a large constant DC offset should be flagged as a likely mic fault.
#[test]
fn analyze_and_trim_large_dc_offset_is_flagged() {
    let sample_rate = 16_000;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let total_len = trim_count + 4000;

    let samples: Vec<i16> = vec![5000; total_len];

    let (_trimmed, verdict) = analyze_and_trim(&samples, sample_rate);
    match verdict {
        Err(RecordingError::LikelyMicFault { dc_offset_mean, .. }) => {
            assert!((dc_offset_mean - 5000.0).abs() < 0.01);
        }
        other => panic!("expected LikelyMicFault, got {:?}", other),
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

    let (_trimmed, verdict) = analyze_and_trim(&samples, sample_rate);
    match verdict {
        Err(RecordingError::LikelyMicFault {
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
        other => panic!("expected LikelyMicFault, got {:?}", other),
    }
}
