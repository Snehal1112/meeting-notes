import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export const countMeetingsAt = (path: string) => invoke<number>("count_meetings_at", { path });

export const migrateMeetings = (from: string, to: string) =>
  invoke<void>("migrate_meetings", { from, to });

export const pickFolder = () => open({ directory: true, multiple: false });
