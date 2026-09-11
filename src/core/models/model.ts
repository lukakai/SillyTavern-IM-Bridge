import type { LatestDialogueRecord, MvuStatusSnapshot } from "./chat";

export interface StGenerationSettings {
  username: string;
  personaDescription?: string;
  chatCompletionSource: string;
  model: string;
  customUrl: string;
  customPromptPostProcessing: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

export interface ModelSummary {
  id: string;
  ownedBy: string | null;
  description: string | null;
}

export interface SendMessageResult {
  replyText: string;
  latestRecord: LatestDialogueRecord | null;
  mvuStatus: MvuStatusSnapshot | null;
}

export interface GeneratedReplyCandidate extends SendMessageResult {
  assistantMessage: import("./chat").ChatMessage;
}

export type StreamEvent =
  | { type: "started"; sessionKey: string }
  | { type: "delta"; text: string; fullText: string }
  | { type: "done"; replyText: string; latestRecord: LatestDialogueRecord | null }
  | { type: "error"; message: string };
