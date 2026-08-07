import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  claude_api_key: string | null;
  ollama_endpoint: string | null;
  ollama_model: string | null;
  ollama_num_ctx: number | null;
  summary_provider: string | null;
  whisper_model: string | null;
  data_dir: string | null;
}

export const getConfig = () => invoke<AppConfig>("get_config");
// Like setSummaryProvider/setDataDir: reads the raw persisted file, not the
// env-merged resolved config, so ConfigDialog's pre-fill can never surface
// (and therefore never round-trip back out through saveConfig) a secret the
// user only ever set via environment variable.
export const getRawConfig = () => invoke<AppConfig>("get_raw_config");
export const saveConfig = (config: AppConfig) => invoke<void>("save_config", { config });
export const configNeedsSetup = () => invoke<boolean>("config_needs_setup");
// Deliberately narrower than saveConfig: getConfig() returns environment
// values merged in, so round-tripping the whole object through saveConfig
// would copy an env-only API key into the plaintext config file.
export const setSummaryProvider = (provider: string | null) =>
  invoke<void>("set_summary_provider", { provider });
// Narrow like setSummaryProvider above, for the same reason: persists just
// the storage-location override without round-tripping the rest of the
// resolved (env-merged) config through saveConfig.
export const setDataDir = (dataDir: string | null) => invoke<void>("set_data_dir", { dataDir });
