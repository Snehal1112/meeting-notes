import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MeetingMeta } from "@/lib/storage";

export const transcribeMeeting = (meeting: MeetingMeta, whisperModel: string) =>
  invoke<void>("transcribe_meeting", { meeting, whisperModel });

export const onTranscriptionComplete = (callback: (meeting: MeetingMeta) => void) =>
  listen<MeetingMeta>("transcription-complete", (event) => callback(event.payload));
