import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  claude_api_key: string | null;
  ollama_endpoint: string | null;
  ollama_model: string | null;
  whisper_model: string | null;
}

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (config: AppConfig) => invoke<void>("save_config", { config });
export const configNeedsSetup = () => invoke<boolean>("config_needs_setup");
