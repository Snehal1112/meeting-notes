use super::*;

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
    assert_eq!(
        samples.len(),
        5,
        "output length should match the longer input"
    );
    assert_eq!(samples[..3], [1100, 2200, 3300]);
    // Trailing samples: a's stream has ended (treated as 0), so these equal
    // b's own values unchanged.
    assert_eq!(samples[3..], [400, 500]);

    let _ = std::fs::remove_dir_all(&dir);
}

/// `mix_wav_files` must reject inputs with mismatched WAV specs (here: a
/// different sample rate) rather than silently mixing using only `a_path`'s
/// spec, which would previously produce garbage output.
#[test]
fn mix_wav_files_rejects_mismatched_specs() {
    let dir = std::env::temp_dir().join(format!("mix-test-mismatch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.wav");
    let b = dir.join("b.wav");
    write_test_wav(&a, &[1000, 2000, 3000]);
    write_test_wav_with_rate(&b, &[500, 500, 500], 44_100);
    let out = dir.join("mixed.wav");

    let result = mix_wav_files(&a, &b, &out);
    assert!(
        result.is_err(),
        "expected mix_wav_files to reject mismatched specs, got {:?}",
        result
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Mic-only path: with `system_path: None`, `finalize_output` should rename
/// the mic recording into place (after trim/check) and leave nothing behind
/// at the intermediate mic path.
#[test]
fn finalize_output_mic_only_renames_and_trims() {
    let dir = std::env::temp_dir().join(format!("finalize-mic-only-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("mic.wav");
    let final_path = dir.join("final.wav");

    let sample_rate = 16_000u32;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let leading: Vec<i16> = vec![0; trim_count];
    let trailing: Vec<i16> = vec![500; 2000];
    let samples: Vec<i16> = leading.into_iter().chain(trailing.clone()).collect();
    write_test_wav(&mic_path, &samples);

    let warning = finalize_output(&mic_path, None, &final_path).expect("should finalize");
    assert!(warning.is_none(), "expected no warning, got {:?}", warning);

    assert!(final_path.exists(), "expected final output file to exist");
    assert!(!mic_path.exists(), "expected mic_path to be renamed away");

    let mut reader = hound::WavReader::open(&final_path).unwrap();
    let out_samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(out_samples, trailing);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Dual-stream success path: with both mic and system files present and
/// mixable, `finalize_output` should produce a mixed+trimmed final file and
/// clean up both intermediate files.
#[test]
fn finalize_output_dual_stream_mixes_and_cleans_up() {
    let dir = std::env::temp_dir().join(format!("finalize-dual-ok-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("mic.wav");
    let system_path = dir.join("system.wav");
    let final_path = dir.join("final.wav");

    let sample_rate = 16_000u32;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let leading: Vec<i16> = vec![0; trim_count];
    let mic_trailing: Vec<i16> = vec![300; 2000];
    let system_trailing: Vec<i16> = vec![200; 2000];
    let mic_samples: Vec<i16> = leading
        .iter()
        .copied()
        .chain(mic_trailing.clone())
        .collect();
    let system_samples: Vec<i16> = leading.into_iter().chain(system_trailing.clone()).collect();
    write_test_wav(&mic_path, &mic_samples);
    write_test_wav(&system_path, &system_samples);

    let warning =
        finalize_output(&mic_path, Some(&system_path), &final_path).expect("should finalize");
    assert!(warning.is_none(), "expected no warning, got {:?}", warning);

    assert!(final_path.exists(), "expected final output file to exist");
    assert!(!mic_path.exists(), "expected mic_path to be cleaned up");
    assert!(
        !system_path.exists(),
        "expected system_path to be cleaned up"
    );

    let mut reader = hound::WavReader::open(&final_path).unwrap();
    let out_samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    let expected: Vec<i16> = mic_trailing
        .iter()
        .zip(system_trailing.iter())
        .map(|(&a, &b)| a + b)
        .collect();
    assert_eq!(out_samples, expected);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Dual-stream failure path (the bug fix this task exists for): if the
/// system-audio file can't be mixed (here: it doesn't exist / isn't a valid
/// WAV), `finalize_output` must fall back to the mic-only recording rather
/// than losing it -- i.e. it must return `Ok` with the mic content present at
/// `final_output_path`, not `Err` with nothing written.
#[test]
fn finalize_output_falls_back_to_mic_only_on_mix_failure() {
    let dir = std::env::temp_dir().join(format!("finalize-dual-fail-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("mic.wav");
    // Deliberately does not exist / isn't a valid WAV file, so mix_wav_files fails.
    let system_path = dir.join("does-not-exist.wav");
    let final_path = dir.join("final.wav");

    let sample_rate = 16_000u32;
    let trim_count = ((sample_rate as u64 * TRIM_LEADING_MS as u64) / 1000) as usize;
    let leading: Vec<i16> = vec![0; trim_count];
    let trailing: Vec<i16> = vec![777; 2000];
    let samples: Vec<i16> = leading.into_iter().chain(trailing.clone()).collect();
    write_test_wav(&mic_path, &samples);

    let result = finalize_output(&mic_path, Some(&system_path), &final_path);
    assert!(
        result.is_ok(),
        "expected finalize_output to gracefully fall back to mic-only, got {:?}",
        result
    );

    assert!(
        final_path.exists(),
        "expected final output file to exist via mic-only fallback"
    );
    assert!(!mic_path.exists(), "expected mic_path to be renamed away");

    let mut reader = hound::WavReader::open(&final_path).unwrap();
    let out_samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(out_samples, trailing);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Normal, non-interrupted case: `final_output_path` already exists (a
/// completed recording), so there is nothing to recover -- must be a no-op
/// that leaves the existing file untouched, not an error.
#[test]
fn recover_interrupted_recording_is_a_noop_when_final_output_already_exists() {
    let dir = std::env::temp_dir().join(format!("recover-noop-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let final_path = dir.join("audio.wav");
    write_test_wav(&final_path, &[42, 43, 44]);

    let warning =
        recover_interrupted_recording(&final_path).expect("should be a no-op, not an error");
    assert!(warning.is_none());

    let mut reader = hound::WavReader::open(&final_path).unwrap();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(samples, vec![42, 43, 44], "existing final output must be untouched");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The actual interrupted-recording bug: `stop()` was never called, so only
/// the intermediate `<id>.mic.wav` exists (no system audio in this case).
/// Recovery must finalize it into `final_output_path` exactly like `stop()`
/// would have, so transcription can find the file it expects.
#[test]
fn recover_interrupted_recording_finalizes_a_lone_orphaned_mic_file() {
    let dir = std::env::temp_dir().join(format!("recover-mic-only-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let final_path = dir.join("audio.wav");
    let mic_path = dir.join("audio.mic.wav");
    write_test_wav(&mic_path, &[10, 20, 30]);

    let warning = recover_interrupted_recording(&final_path).expect("should recover");
    assert!(warning.is_none());

    assert!(final_path.exists(), "expected final output to be created");
    assert!(!mic_path.exists(), "expected intermediate mic file to be consumed");

    let mut reader = hound::WavReader::open(&final_path).unwrap();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(samples, vec![10, 20, 30]);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Same as above but with both mic and system intermediate files present --
/// recovery must mix them exactly like a normal `stop()` would.
#[test]
fn recover_interrupted_recording_mixes_orphaned_mic_and_system_files() {
    let dir = std::env::temp_dir().join(format!("recover-dual-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let final_path = dir.join("audio.wav");
    let mic_path = dir.join("audio.mic.wav");
    let system_path = dir.join("audio.system.wav");
    write_test_wav(&mic_path, &[100, 200, 300]);
    write_test_wav(&system_path, &[1, 2, 3]);

    let warning = recover_interrupted_recording(&final_path).expect("should recover");
    assert!(warning.is_none());

    assert!(final_path.exists());
    assert!(!mic_path.exists());
    assert!(!system_path.exists());

    let mut reader = hound::WavReader::open(&final_path).unwrap();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
    assert_eq!(samples, vec![101, 202, 303]);

    let _ = std::fs::remove_dir_all(&dir);
}

/// Genuine data loss case: neither the final output nor any intermediate
/// capture file exists (e.g. the recording crashed before pw-record ever
/// wrote anything). Recovery must fail with a clear, specific error rather
/// than silently letting a missing-file whisper.cpp crash stand in for it.
#[test]
fn recover_interrupted_recording_errors_when_no_audio_was_ever_captured() {
    let dir = std::env::temp_dir().join(format!("recover-nothing-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let final_path = dir.join("audio.wav");

    let result = recover_interrupted_recording(&final_path);
    assert!(
        result.is_err(),
        "expected an error when no audio was ever captured, got {:?}",
        result
    );

    let _ = std::fs::remove_dir_all(&dir);
}

fn write_test_wav(path: &std::path::Path, samples: &[i16]) {
    write_test_wav_with_rate(path, samples, 16000);
}

fn write_test_wav_with_rate(path: &std::path::Path, samples: &[i16], sample_rate: u32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for s in samples {
        writer.write_sample(*s).unwrap();
    }
    writer.finalize().unwrap();
}
