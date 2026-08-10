use meeting_notes_core::transcript::{TranscriptResult, TranscriptSegment};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Ordered, most-specific-first list of absolute paths where an installed
/// whisper.cpp CLI binary might live. A bare `"whisper-cli"` only resolves
/// via the process's `PATH`, which works for `bun run tauri dev` (inherits
/// the launching shell's PATH) but not a deb-installed app launched from the
/// desktop session — that session's PATH doesn't include `~/.local/bin`.
fn whisper_binary_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/whisper-cli"));
        candidates.push(home.join(".local/lib/whisper.cpp/whisper-cli"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/whisper-cli"));
    candidates.push(PathBuf::from("/usr/bin/whisper-cli"));
    candidates
}

fn resolve_whisper_binary(
    env_override: Option<String>,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> String {
    if let Some(path) = env_override {
        return path;
    }
    match whisper_binary_candidates(home).into_iter().find(|p| exists(p)) {
        Some(found) => found.to_string_lossy().into_owned(),
        None => "whisper-cli".to_string(),
    }
}

/// Locates the whisper.cpp CLI binary: the `MEETING_NOTES_WHISPER_BIN` env
/// var override first, then well-known install locations, then a bare
/// `"whisper-cli"` for PATH resolution as a last resort.
fn whisper_binary_path() -> String {
    resolve_whisper_binary(
        std::env::var("MEETING_NOTES_WHISPER_BIN").ok(),
        std::env::var_os("HOME").as_deref().map(Path::new),
        |p| p.is_file(),
    )
}

/// Ordered, most-specific-first list of directories to search for whisper.cpp
/// ggml model files: the app's own data directory first, then a `models/`
/// directory relative to the current working directory (dev convenience —
/// true for `bun run tauri dev`, not guaranteed for a deb-installed binary
/// launched from the desktop session).
fn whisper_model_dir_candidates(data_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(data_dir) = data_dir {
        candidates.push(data_dir.join("models"));
    }
    candidates.push(PathBuf::from("models"));
    candidates
}

fn resolve_whisper_model_path(
    model: &str,
    env_override: Option<String>,
    data_dir: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    let filename = format!("ggml-{model}.bin");
    if let Some(dir) = env_override {
        return PathBuf::from(dir).join(&filename);
    }
    let candidates = whisper_model_dir_candidates(data_dir);
    candidates
        .iter()
        .map(|dir| dir.join(&filename))
        .find(|p| exists(p))
        .unwrap_or_else(|| candidates[0].join(&filename))
}

/// Locates the whisper.cpp ggml model file: the `MEETING_NOTES_WHISPER_MODEL_DIR`
/// env var override first, then `data_dir` (the caller's already-resolved app
/// data directory — respects the user's configured Storage Location, if any),
/// then a `models/` directory relative to the current working directory.
fn whisper_model_path(model: &str, data_dir: Option<&Path>) -> PathBuf {
    resolve_whisper_model_path(
        model,
        std::env::var("MEETING_NOTES_WHISPER_MODEL_DIR").ok(),
        data_dir,
        |p| p.is_file(),
    )
}

/// Runs whisper.cpp on `audio_path` using the given model name. `data_dir` is
/// the caller's already-resolved app data directory (see `whisper_model_path`) —
/// pass `None` only when no such directory is available.
pub fn run_whisper(
    audio_path: &Path,
    model: &str,
    data_dir: Option<&Path>,
) -> Result<TranscriptResult, String> {
    let binary = whisper_binary_path();
    let model_path = whisper_model_path(model, data_dir);
    let output_base = audio_path.with_extension(""); // whisper.cpp appends .json itself

    let status = Command::new(&binary)
        .arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(audio_path)
        .arg("-oj") // output json
        .arg("-of")
        .arg(&output_base)
        .status()
        .map_err(|e| {
            format!(
                "failed to spawn whisper.cpp at \"{binary}\": {e} \
                 (install it or set MEETING_NOTES_WHISPER_BIN)"
            )
        })?;

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
