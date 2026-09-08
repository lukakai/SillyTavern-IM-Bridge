export interface CharacterSummary {
  avatar: string;
  name: string;
  dateLastChat: number | null;
  chatSize: number | null;
  dataSize: number | null;
}

export interface ChatSearchResult {
  fileId: string;
  fileName: string;
  fileSize: string;
  messageCount: number;
  lastMessageAt: string | number | null;
  previewMessage: string;
}

export interface StoredChatSession extends ChatSearchResult {
  avatar: string;
  characterName: string;
}

export interface ChatMessage {
  name?: string;
  mes?: string;
  send_date?: string;
  is_user?: boolean;
  is_system?: boolean;
  extra?: {
    display_text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MvuRangeHint {
  min: number;
  max: number;
}

export interface MvuCardConfig {
  initialStateText: string | null;
  updatePrompt: string;
  rangeHints: Record<string, MvuRangeHint>;
}

export interface MvuStatusSnapshot {
  statData: Record<string, unknown>;
  rangeHints: Record<string, MvuRangeHint>;
}

export interface LatestDialogueRecord {
  messageId: string;
  turnId: string | null;
  speaker: string;
  text: string;
  sendDate: string | null;
  isUser: boolean;
}

export interface HistorySyncRecord extends LatestDialogueRecord {
  sortIndex: number;
}

export type HistorySyncMode = "unchanged" | "delta" | "full";

export interface HistorySyncResult {
  sessionKey: string;
  historyRevision: number;
  mode: HistorySyncMode;
  baseSortIndex: number;
  latestSortIndex: number;
  items: HistorySyncRecord[];
}

export interface LastTurnDetails {
  userMessage: LatestDialogueRecord | null;
  assistantMessage: LatestDialogueRecord | null;
}

export interface CharacterCardDetails {
  avatar: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  mvu: MvuCardConfig | null;
}
