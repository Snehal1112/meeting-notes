use crate::{finalize_output, QualityWarning, RecordingError};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

pub struct RecordingHandle {
    mic_child: Child,
    system_child: Option<Child>,
    mic_path: PathBuf,
    system_path: Option<PathBuf>,
    final_output_path: PathBuf,
}

impl RecordingHandle {
    /// Starts recording default mic input, and — if a default sink is
    /// found via `find_default_sink_id()` — system (playback) audio too, to
    /// separate WAV files via `pw-record`. Returns the handle along with a
    /// `used_system_audio` bool: `true` when a second `pw-record` process
    /// was spawned to capture system audio, `false` when no default sink
    /// was found and this falls back to mic-only capture.
    pub fn start(final_output_path: &Path) -> std::io::Result<(Self, bool)> {
        let mic_path = final_output_path.with_extension("mic.wav");
        let mut mic_child = Command::new("pw-record")
            .args(["--channels=1", "--rate=16000"])
            .arg(&mic_path)
            .spawn()?;

        let (system_child, system_path, used_system_audio) = match find_default_sink_id() {
            Some(id) => {
                let sys_path = final_output_path.with_extension("system.wav");
                // No shell is involved here, so the -P value is passed as a
                // single argv entry as-is — it must NOT be shell-quoted.
                // See docs/superpowers/specs/environment.md, "Task 2:
                // PipeWire audio capture" for why `--target <sink-id> -P
                // '{ stream.capture.sink=true }'` is required to capture a
                // sink's own audio (there's no pactl-style monitor source).
                match Command::new("pw-record")
                    .args(["--channels=1", "--rate=16000", "--target"])
                    .arg(id.to_string())
                    .args(["-P", "{ stream.capture.sink=true }"])
                    .arg(&sys_path)
                    .spawn()
                {
                    Ok(child) => (Some(child), Some(sys_path), true),
                    Err(e) => {
                        // The mic pw-record already spawned successfully; if we
                        // bail out here without killing it, it keeps recording
                        // forever with no RecordingHandle (and no Drop guard)
                        // ever created to watch it.
                        let _ = mic_child.kill();
                        let _ = mic_child.wait();
                        return Err(e);
                    }
                }
            }
            None => (None, None, false),
        };

        Ok((
            RecordingHandle {
                mic_child,
                system_child,
                mic_path,
                system_path,
                final_output_path: final_output_path.to_path_buf(),
            },
            used_system_audio,
        ))
    }

    /// Stops the recording(s) by sending SIGTERM so `pw-record` finalizes the
    /// WAV file(s), then produces the final output at `final_output_path` via
    /// `finalize_output`: mixed mic+system audio when system audio was
    /// captured and mixing succeeds, or just the mic recording (renamed into
    /// place) otherwise -- including as a graceful fallback if mixing fails.
    /// Either way, the leading DC-offset settling window is trimmed and the
    /// result is checked for signs of a DC-offset/clipping issue, exactly as
    /// before — just now applied once to the final (possibly mixed) output
    /// rather than the raw mic stream.
    pub fn stop(&mut self) -> Result<Option<QualityWarning>, RecordingError> {
        // pw-record needs a graceful signal (not kill -9) to write valid WAV headers.
        unsafe {
            libc::kill(self.mic_child.id() as i32, libc::SIGTERM);
        }
        self.mic_child.wait()?;

        if let Some(child) = &mut self.system_child {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            child.wait()?;
        }

        finalize_output(
            &self.mic_path,
            self.system_path.as_deref(),
            &self.final_output_path,
        )
    }

    pub fn output_path(&self) -> &Path {
        &self.final_output_path
    }
}

impl Drop for RecordingHandle {
    fn drop(&mut self) {
        // Best-effort: if the process already exited, this is a no-op signal to a dead pid.
        unsafe {
            libc::kill(self.mic_child.id() as i32, libc::SIGTERM);
        }
        let _ = self.mic_child.wait();
        if let Some(child) = &mut self.system_child {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let _ = child.wait();
        }
    }
}

/// Runs `wpctl status` and returns the numeric node id of the default
/// (`*`-marked) sink, or `None` if `wpctl` isn't found, exits non-zero, or no
/// default sink is found.
///
/// Note: plain PipeWire (no PulseAudio compatibility layer) has no
/// `pactl`-style `"<sink>.monitor"` source name to target — capturing a
/// sink's audio requires targeting the sink's own node id with `pw-record
/// --target <id> -P '{ stream.capture.sink=true }'`. See
/// docs/superpowers/specs/environment.md, "Task 2: PipeWire audio capture",
/// for the verified-working command and the environment where `pactl` isn't
/// installed at all.
fn find_default_sink_id() -> Option<u32> {
    let output = Command::new("wpctl").arg("status").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_default_sink_id(&stdout)
}

/// Parses `wpctl status` output and returns the numeric node id of the line
/// marked `*` under the "Sinks:" section specifically (not "Sources:",
/// "Sink endpoints:", or any other section — we want a playback sink to
/// monitor, not a capture source). Pure function, no I/O, so it can be unit
/// tested without `wpctl` installed or real hardware.
fn parse_default_sink_id(wpctl_status_output: &str) -> Option<u32> {
    let mut in_sinks = false;
    for line in wpctl_status_output.lines() {
        let trimmed = line.trim();
        if trimmed.ends_with("Sinks:") {
            // Matches "Sinks:" but not "Sink endpoints:" (which doesn't end
            // with "Sinks:"), so we don't accidentally scan that section too.
            in_sinks = true;
            continue;
        }
        if trimmed.ends_with(':') {
            // Any other section header (Sources:, Sink endpoints:, Streams:,
            // Devices:, ...) ends the Sinks section.
            in_sinks = false;
            continue;
        }
        if !in_sinks {
            continue;
        }
        if let Some(star_pos) = line.find('*') {
            let rest = line[star_pos + 1..].trim_start();
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(id) = digits.parse::<u32>() {
                return Some(id);
            }
        }
    }
    None
}

#[cfg(test)]
mod linux_tests;
