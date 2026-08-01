import { invoke } from "@tauri-apps/api/core";

export interface StopRecordingResult {
  output_path: string;
  quality_warning: string | null;
}

export const startRecording = (outputPath: string) =>
  invoke<void>("start_recording", { outputPath });

export const stopRecording = () => invoke<StopRecordingResult>("stop_recording");
