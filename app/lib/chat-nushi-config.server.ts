import type { LlmEnv } from "./llm/types";
import { nushiAllowedInVillage, nushiPlaceEnabled } from "./nushi-config.server";
import { villageChatEnabled } from "./village-chat-enabled.server";

export const CHAT_NUSHI_PROMPT_VERSION = "chat-nushi-v11";
export const chatNushiEnabled = (env: LlmEnv = process.env) => env.VILLAGE_CHAT_NUSHI === "1";
export function chatNushiPlaceEnabled(env: LlmEnv = process.env) {
  return villageChatEnabled(env) && nushiPlaceEnabled(env);
}
export function chatNushiInVillage(village: Parameters<typeof nushiAllowedInVillage>[0], env: LlmEnv = process.env) {
  return chatNushiEnabled(env) && chatNushiPlaceEnabled(env) && nushiAllowedInVillage(village);
}
