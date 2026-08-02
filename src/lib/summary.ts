import { invoke } from "@tauri-apps/api/core";

export interface SummaryResult {
  summary: string;
  action_items: string[];
}

export const summarizeMeeting = (meetingId: string) =>
  invoke<SummaryResult>("summarize_meeting", { meetingId });
