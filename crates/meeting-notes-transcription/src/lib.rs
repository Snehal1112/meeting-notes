use meeting_notes_core::transcript::{TranscriptResult, TranscriptSegment};
use std::path::Path;
use std::process::Command;

/// Locates the bundled whisper.cpp CLI binary. Checks an env var override first,
/// then falls back to a path relative to the app's resource directory.
fn whisper_binary_path() -> String {
    std::env::var("MEETING_NOTES_WHISPER_BIN").unwrap_or_else(|_| "whisper-cli".to_string())
}

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

#[cfg(test)]
mod tests;
