import { invoke } from "@tauri-apps/api/core";

/// Mirrors the Rust `MeetingType` enum, which serialises unit variants as
/// plain strings. Distinct from `SummaryResult.meeting_type`, which is the
/// free-text descriptor the model infers from the transcript.
export type MeetingType =
  | "Standup"
  | "Retrospective"
  | "FeatureRequest"
  | "Incident"
  | "AutoDetect";

export interface MeetingMeta {
  id: string;
  title: string;
  created_at: string;
  duration_seconds: number | null;
  status: "Recording" | "Transcribing" | "Summarizing" | "Done" | "Failed";
  used_system_audio: boolean;
  meeting_type: MeetingType;
}

export const createNewMeeting = (title: string, meetingType: MeetingType) =>
  invoke<MeetingMeta>("create_new_meeting", { title, meetingType });

export const updateMeetingStatus = (meeting: MeetingMeta) =>
  invoke<void>("update_meeting_status", { meeting });

export const getOrphanedMeetings = () => invoke<MeetingMeta[]>("get_orphaned_meetings");

export const getDataDir = () => invoke<string>("get_data_dir");

// Opens a meeting's summary.md in the system's default handler via a
// backend command rather than the opener plugin's own `open_path` IPC
// command directly -- see the doc comment on the Rust `open_summary`
// command for why (its capability scope is static and can't be extended to
// an arbitrary configured data directory at runtime).
export const openSummary = (meetingId: string) => invoke<void>("open_summary", { meetingId });
