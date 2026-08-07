import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MeetingMeta } from "@/lib/storage";

export const transcribeMeeting = (meetingId: string, whisperModel: string) =>
  invoke<void>("transcribe_meeting", { meetingId, whisperModel });

export const readTranscriptText = (meetingId: string) =>
  invoke<string>("read_transcript_text", { meetingId });

export const onTranscriptionComplete = (callback: (meeting: MeetingMeta) => void) =>
  listen<MeetingMeta>("transcription-complete", (event) => callback(event.payload));
