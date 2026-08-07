import { invoke } from "@tauri-apps/api/core";
import type { MeetingMeta } from "@/lib/storage";

// Mirrors the Rust MeetingHistoryEntry: `meta` is flattened into this shape
// server-side (see history_commands.rs), so error_message already comes
// from MeetingMeta itself -- there is no separate failure_reason field.
export interface MeetingHistoryEntry extends MeetingMeta {
  snippet: string | null;
}

export const getMeetingHistory = () => invoke<MeetingHistoryEntry[]>("get_meeting_history");

export const deleteMeeting = (meetingId: string) => invoke<void>("delete_meeting", { meetingId });

export const revealInFileManager = (meetingId: string) =>
  invoke<void>("reveal_in_file_manager", { meetingId });
