import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@/lib/config";

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

// Resolves which provider a summarization run should use: the user's
// persisted preference (set via the idle-state ProviderPicker) when it
// names a provider that's actually configured this run, falling back to
// the same Ollama-preferring order select_provider_kind uses on the Rust
// side (see crates/meeting-notes-summary/src/lib.rs) when there is no
// persisted preference or it names something unavailable. Returns
// undefined when nothing is configured, letting callers fall through to
// the backend's own "not_configured" error.
//
// Shared between ProviderPicker.tsx (what the Idle screen highlights) and
// RecorderWidget.tsx (what a run actually uses), so the two can never
// disagree about which provider is "selected".
export function resolveProvider(config: AppConfig | null): ProviderKind | undefined {
  if (!config) return undefined;
  const available: ProviderKind[] = [
    ...(config.claude_api_key ? (["Claude"] as const) : []),
    ...(config.ollama_endpoint ? (["Ollama"] as const) : []),
  ];
  if (available.length === 0) return undefined;
  const persisted = toProviderKind(config.summary_provider);
  return persisted && available.includes(persisted)
    ? persisted
    : available.includes("Ollama")
      ? "Ollama"
      : available[0];
}
