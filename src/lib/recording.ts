import { invoke } from "@tauri-apps/api/core";

export interface StopRecordingResult {
  output_path: string;
  quality_warning: string | null;
}

export const startRecording = (outputPath: string) =>
  invoke<boolean>("start_recording", { outputPath }); // returns usedSystemAudio

export const stopRecording = () => invoke<StopRecordingResult>("stop_recording");
