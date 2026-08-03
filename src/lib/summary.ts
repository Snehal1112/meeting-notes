import { invoke } from "@tauri-apps/api/core";

export interface Topic {
  title: string;
  points: string[];
}

export interface ActionItem {
  text: string;
  owner: string | null;
}

export interface SummaryResult {
  meeting_type: string;
  attendees: string[];
  referenced_people: string[];
  summary: string;
  topics: Topic[];
  decisions: string[];
  action_items: ActionItem[];
  open_questions: string[];
}

export const summarizeMeeting = (meetingId: string) =>
  invoke<SummaryResult>("summarize_meeting", { meetingId });
