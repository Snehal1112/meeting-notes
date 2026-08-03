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

export type ProviderKind = "Claude" | "Ollama";

// Single conversion point between the persisted, lowercase ProviderName
// ("ollama" | "claude", as stored in AppConfig.summary_provider) and the
// capitalized ProviderKind this module and the Rust side use. Returns null
// for anything unset or unrecognized, so callers fall back to their own
// default rather than guessing.
export function toProviderKind(name: string | null): ProviderKind | null {
  if (!name) return null;
  if (name.toLowerCase() === "claude") return "Claude";
  if (name.toLowerCase() === "ollama") return "Ollama";
  return null;
}

export const summarizeMeeting = (meetingId: string, providerOverride?: ProviderKind) =>
  invoke<SummaryResult>("summarize_meeting", { meetingId, providerOverride: providerOverride ?? null });
