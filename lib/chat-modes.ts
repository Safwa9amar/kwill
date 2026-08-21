import { MessageCircleQuestion, ClipboardList, Sparkles, Zap } from "lucide-react-native";

// The four conversation modes, mirrored from the server registry
// (~/modakerati-server/src/lib/ai/chat-modes.ts). Data only — what a mode DOES is
// decided server-side; the app only shows it and sends it.
export type ChatMode = "ask" | "plan" | "assist" | "agent";

export const CHAT_MODES: ChatMode[] = ["ask", "plan", "assist", "agent"];
export const DEFAULT_CHAT_MODE: ChatMode = "assist";

export const CHAT_MODE_ICONS: Record<ChatMode, typeof Sparkles> = {
  ask: MessageCircleQuestion,
  plan: ClipboardList,
  assist: Sparkles,
  agent: Zap,
};

/** i18n key for a mode's short label (the chip) and its one-line description (the sheet). */
export const chatModeLabelKey = (m: ChatMode) => `chatModes.${m}.label`;
export const chatModeHintKey = (m: ChatMode) => `chatModes.${m}.hint`;

export function isChatMode(v: unknown): v is ChatMode {
  return v === "ask" || v === "plan" || v === "assist" || v === "agent";
}

/** A thread's mode, tolerating an older server that returns none. */
export function chatModeOf(value: unknown): ChatMode {
  return isChatMode(value) ? value : DEFAULT_CHAT_MODE;
}
