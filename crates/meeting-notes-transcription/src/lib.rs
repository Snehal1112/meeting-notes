use meeting_notes_core::transcript::{TranscriptResult, TranscriptSegment};
use std::path::Path;
use std::process::Command;

/// Locates the whisper.cpp CLI binary. Checks the `MEETING_NOTES_WHISPER_BIN`
/// env var override first, then falls back to the bare name "whisper-cli",
/// which relies on it being resolvable via the process's PATH.
/// TODO: packaged builds need this resolved via Tauri's resource directory,
/// not yet implemented.
fn whisper_binary_path() -> String {
    std::env::var("MEETING_NOTES_WHISPER_BIN").unwrap_or_else(|_| "whisper-cli".to_string())
}

/// Runs whisper.cpp on `audio_path` using the given model name.
///
/// Resolves the model at the relative path `models/ggml-{model}.bin`, so the
/// caller's process working directory must be `src-tauri/` (true for the app
/// when launched via `bun run tauri dev`/the built binary). Callers running
/// from elsewhere (e.g. tests invoked from a different crate directory) must
/// `std::env::set_current_dir` into `src-tauri/` first.
pub fn run_whisper(audio_path: &Path, model: &str) -> Result<TranscriptResult, String> {
    let model_path = format!("models/ggml-{model}.bin");
    let output_base = audio_path.with_extension(""); // whisper.cpp appends .json itself

    let status = Command::new(whisper_binary_path())
        .arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(audio_path)
        .arg("-oj") // output json
        .arg("-of")
        .arg(&output_base)
        .status()
        .map_err(|e| format!("failed to spawn whisper.cpp: {e}"))?;

    if !status.success() {
        return Err(format!("whisper.cpp exited with status {status}"));
    }

    let json_path = output_base.with_extension("json");
    let contents = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("failed to read whisper output: {e}"))?;
    parse_whisper_json(&contents)
}

fn parse_whisper_json(contents: &str) -> Result<TranscriptResult, String> {
    let raw: serde_json::Value =
        serde_json::from_str(contents).map_err(|e| format!("invalid whisper json: {e}"))?;
    let transcription = raw["transcription"]
        .as_array()
        .ok_or("missing 'transcription' array in whisper output")?;

    let segments = transcription
        .iter()
        .map(|seg| TranscriptSegment {
            start_time: seg["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0,
            end_time: seg["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0,
            text: seg["text"].as_str().unwrap_or("").trim().to_string(),
        })
        .collect();

    Ok(TranscriptResult { segments })
}

pub fn save_transcript(meeting_dir: &Path, result: &TranscriptResult) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(&result.segments)?;
    std::fs::write(meeting_dir.join("transcript.json"), json)?;

    let plain_text = result
        .segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    std::fs::write(meeting_dir.join("transcript.txt"), plain_text)?;
    Ok(())
}

#[cfg(test)]
mod tests;
