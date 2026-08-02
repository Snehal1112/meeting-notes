import { invoke } from "@tauri-apps/api/core";

export interface MeetingMeta {
  id: string;
  title: string;
  created_at: string;
  duration_seconds: number | null;
  status: "Recording" | "Transcribing" | "Summarizing" | "Done" | "Failed";
  used_system_audio: boolean;
}

export const createNewMeeting = (title: string) =>
  invoke<MeetingMeta>("create_new_meeting", { title });

export const updateMeetingStatus = (meeting: MeetingMeta) =>
  invoke<void>("update_meeting_status", { meeting });

export const getOrphanedMeetings = () => invoke<MeetingMeta[]>("get_orphaned_meetings");

export const getDataDir = () => invoke<string>("get_data_dir");
