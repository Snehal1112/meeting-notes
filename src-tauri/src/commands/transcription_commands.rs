use crate::commands::resolved_base_dir;
use meeting_notes_audio::recover_interrupted_recording;
use meeting_notes_core::meeting::{MeetingMeta, MeetingStatus};
use meeting_notes_storage::{load_index, update_meeting};
use meeting_notes_transcription::{run_whisper, save_transcript};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn transcribe_meeting(
    app: AppHandle,
    meeting: MeetingMeta,
    whisper_model: String,
) -> Result<(), String> {
    let base = resolved_base_dir()?;

    match run_transcription(&base, meeting.clone(), whisper_model).await {
        Ok(updated) => {
            app.emit("transcription-complete", &updated)
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            // Don't leave the meeting stuck at "Transcribing" forever if
            // whisper.cpp, the transcript write, or the index update itself
            // failed — best-effort mark it Failed instead. Mirrors the
            // fire-and-log pattern already used in RecorderWidget.tsx's
            // handleStart: a failure here must not mask the original error
            // returned to the caller.
            mark_meeting_failed(&base, meeting);
            Err(e)
        }
    }
}

/// Returns the saved plain-text transcript for a meeting, so the widget's
/// transcript tab can display it without the frontend needing filesystem
/// access.
#[tauri::command]
pub fn read_transcript_text(meeting_id: String) -> Result<String, String> {
    let base = resolved_base_dir()?;
    read_transcript_for_meeting(&base, &meeting_id)
}

/// Looks the meeting up in the index by id and reads its `transcript.txt`.
/// Split out from the command so it can be unit tested against a temporary
/// data directory. Takes an id rather than a client-supplied `MeetingMeta`
/// for the same reason `summarize_meeting` does: the server should trust its
/// own copy of the record.
fn read_transcript_for_meeting(base: &Path, meeting_id: &str) -> Result<String, String> {
    let index = load_index(base).map_err(|e| e.to_string())?;
    let meeting = index
        .into_iter()
        .find(|m| m.id == meeting_id)
        .ok_or_else(|| format!("meeting {meeting_id} not found"))?;

    std::fs::read_to_string(meeting.dir_path(base).join("transcript.txt"))
        .map_err(|e| format!("could not read transcript: {e}"))
}

/// Finalizes `audio.wav` from an interrupted recording's intermediate
/// `<id>.mic.wav`/`<id>.system.wav` files if it doesn't already exist. A
/// no-op for a normal, non-interrupted recording, where `audio.wav` was
/// already produced by `stop()`. Needed because resuming a meeting after a
/// crash jumps straight to transcription (see `RecorderWidget.tsx`), which
/// otherwise expects `audio.wav` to be present.
fn ensure_final_audio(meeting_dir: &Path) -> Result<(), String> {
    recover_interrupted_recording(&meeting_dir.join("audio.wav"))
        .map(|_quality_warning| ())
        .map_err(|e| e.to_string())
}

/// Runs whisper.cpp on the meeting's audio, persists the transcript, and
/// marks the meeting Summarizing in the index. Returns the updated meeting
/// on success. Split out from `transcribe_meeting` so the AppHandle-free
/// failure-handling logic can be unit tested without a running Tauri app.
async fn run_transcription(
    base: &Path,
    meeting: MeetingMeta,
    whisper_model: String,
) -> Result<MeetingMeta, String> {
    let meeting_dir = meeting.dir_path(base);
    ensure_final_audio(&meeting_dir)?;
    let audio_path = meeting_dir.join("audio.wav");

    let result = tauri::async_runtime::spawn_blocking(move || run_whisper(&audio_path, &whisper_model))
        .await
        .map_err(|e| e.to_string())??;

    save_transcript(&meeting_dir, &result).map_err(|e| e.to_string())?;

    let mut updated = meeting;
    updated.status = MeetingStatus::Summarizing;
    update_meeting(base, &updated).map_err(|e| e.to_string())?;

    Ok(updated)
}

/// Best-effort marks `meeting` Failed in the index. Logs to stderr (rather
/// than propagating) if even that write fails, since the caller already has
/// a more relevant error to report.
fn mark_meeting_failed(base: &Path, mut meeting: MeetingMeta) {
    meeting.status = MeetingStatus::Failed;
    if let Err(e) = update_meeting(base, &meeting) {
        eprintln!(
            "failed to mark meeting {} as Failed after a transcription error: {e}",
            meeting.id
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meeting_notes_core::meeting::MeetingType;
    use meeting_notes_storage::{append_to_index, create_meeting};
    use std::path::PathBuf;

    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "meeting-notes-transcription-commands-test-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
        ));
        std::fs::create_dir_all(&dir).expect("create temp base dir");
        dir
    }

    #[test]
    fn read_transcript_for_meeting_returns_the_saved_transcript_text() {
        let base = temp_base("reads-transcript");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");
        std::fs::write(
            meeting.dir_path(&base).join("transcript.txt"),
            "Alice: Let's ship on Friday.",
        )
        .expect("write transcript");

        let text = read_transcript_for_meeting(&base, &meeting.id).expect("read transcript");
        assert_eq!(text, "Alice: Let's ship on Friday.");

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_transcript_for_meeting_errors_when_the_meeting_is_not_in_the_index() {
        let base = temp_base("transcript-missing-meeting");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        assert!(read_transcript_for_meeting(&base, "nonexistent-id").is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_transcript_for_meeting_errors_when_no_transcript_was_written() {
        // Transcription failed or never ran, so transcript.txt is absent.
        // That must surface as an error rather than an empty transcript,
        // which the UI would render as a blank but valid transcript tab.
        let base = temp_base("transcript-missing-file");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        assert!(read_transcript_for_meeting(&base, &meeting.id).is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mark_meeting_failed_persists_failed_status_in_the_index() {
        let base = temp_base("marks-failed");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");

        mark_meeting_failed(&base, meeting.clone());

        let index = load_index(&base).expect("load index");
        let persisted = index
            .iter()
            .find(|m| m.id == meeting.id)
            .expect("meeting present in index");
        assert_eq!(persisted.status, MeetingStatus::Failed);

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ensure_final_audio_finalizes_an_orphaned_mic_only_recording() {
        // Simulates the resume-after-crash path: `stop()` never ran, so only
        // the mic intermediate exists on disk, not `audio.wav`. Transcription
        // must not be handed a missing file.
        let base = temp_base("ensure-final-audio-recovers-mic-only");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");
        let meeting_dir = meeting.dir_path(&base);
        std::fs::create_dir_all(&meeting_dir).expect("create meeting dir");
        write_test_wav(&meeting_dir.join("audio.mic.wav"), &[1, 2, 3]);

        ensure_final_audio(&meeting_dir).expect("should recover the orphaned recording");

        assert!(
            meeting_dir.join("audio.wav").exists(),
            "expected audio.wav to be finalized from the orphaned mic intermediate"
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn ensure_final_audio_is_a_noop_when_audio_wav_already_exists() {
        // The normal, non-interrupted case: `stop()` already produced
        // `audio.wav`, so recovery must leave it untouched.
        let base = temp_base("ensure-final-audio-noop");
        let meeting = create_meeting(&base, "Test meeting", MeetingType::AutoDetect).expect("create meeting");
        append_to_index(&base, &meeting).expect("append to index");
        let meeting_dir = meeting.dir_path(&base);
        std::fs::create_dir_all(&meeting_dir).expect("create meeting dir");
        write_test_wav(&meeting_dir.join("audio.wav"), &[9, 9, 9]);

        ensure_final_audio(&meeting_dir).expect("should be a no-op");

        let mut reader = hound::WavReader::open(meeting_dir.join("audio.wav")).unwrap();
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(samples, vec![9, 9, 9], "existing audio.wav must be untouched");

        std::fs::remove_dir_all(&base).ok();
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

    #[test]
    fn mark_meeting_failed_does_not_panic_when_meeting_is_not_in_the_index() {
        // The meeting was never appended to index.json (e.g. a resolveable
        // base_dir but an index write that never happened) — update_meeting
        // returns an error, which must be logged, not panicked on.
        let base = temp_base("missing-from-index");
        let meeting = create_meeting(&base, "Untracked meeting", MeetingType::AutoDetect).expect("create meeting");

        mark_meeting_failed(&base, meeting);

        std::fs::remove_dir_all(&base).ok();
    }
}
