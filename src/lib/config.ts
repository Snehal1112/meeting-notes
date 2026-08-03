import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  claude_api_key: string | null;
  ollama_endpoint: string | null;
  ollama_model: string | null;
  ollama_num_ctx: number | null;
  summary_provider: string | null;
  whisper_model: string | null;
}

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (config: AppConfig) => invoke<void>("save_config", { config });
export const configNeedsSetup = () => invoke<boolean>("config_needs_setup");
// Deliberately narrower than saveConfig: getConfig() returns environment
// values merged in, so round-tripping the whole object through saveConfig
// would copy an env-only API key into the plaintext config file.
export const setSummaryProvider = (provider: string | null) =>
  invoke<void>("set_summary_provider", { provider });
