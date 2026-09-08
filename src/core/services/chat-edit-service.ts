import type { ChatMessage, HistorySyncRecord, HistorySyncResult, LastTurnDetails, LatestDialogueRecord, StreamEvent } from "../models/index";
import type { HistorySyncRepository, HistorySyncSnapshot } from "../ports/repositories";
import { AppError } from "../../shared/errors/app-error";
import type { MvuStatusSnapshot } from "../models/index";
import { buildSessionKey, buildSessionMutationKey } from "../../shared/utils/ids";
import {
  formatPreviewText,
  listDialogueRecords,
  listHistorySyncRecords,
  normalizeChatFileName,
  pickLatestDialogueRecord,
  toDialogueRecord,
} from "../../infra/st/st-chat-mapper";
import { StClient } from "../../infra/st/st-client";
import { ConversationService, assertChatIntact } from "./conversation-service";
import { SessionTaskQueue } from "./session-task-queue";

interface MessageRef {
  index: number;
  message: ChatMessage;
}

export interface LastTurnAnalysis {
  user: MessageRef | null;
  assistant: MessageRef | null;
}

function isDialogueMessage(message: ChatMessage | undefined): message is ChatMessage {
  if (!message || message.is_system) {
    return false;
  }

  return typeof message.mes === "string" && message.mes.trim().length > 0;
}

export function analyzeLastTurn(messages: ChatMessage[]): LastTurnAnalysis {
  let lastDialogue: MessageRef | null = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isDialogueMessage(messages[index])) {
      lastDialogue = { index, message: messages[index] };
      break;
    }
  }

  if (!lastDialogue) {
    return { user: null, assistant: null };
  }

  if (lastDialogue.message.is_user) {
    return { user: lastDialogue, assistant: null };
  }

  for (let index = lastDialogue.index - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isDialogueMessage(message)) {
      continue;
    }

    if (message.is_user) {
      return {
        user: { index, message },
        assistant: lastDialogue,
      };
    }

    break;
  }

  return { user: null, assistant: lastDialogue };
}

export function getLastTurnDetails(messages: ChatMessage[]): LastTurnDetails {
  const analysis = analyzeLastTurn(messages);
  return {
    userMessage: analysis.user ? toDialogueRecord("", "", analysis.user.message, analysis.user.index, messages) : null,
    assistantMessage: analysis.assistant ? toDialogueRecord("", "", analysis.assistant.message, analysis.assistant.index, messages) : null,
  };
}

export function removeLastTurnMessages(messages: ChatMessage[]): { chat: ChatMessage[]; removed: LastTurnDetails } {
  const analysis = analyzeLastTurn(messages);
  const indexes = [analysis.user?.index, analysis.assistant?.index]
    .filter((value): value is number => Number.isInteger(value))
    .sort((left, right) => right - left);

  if (indexes.length === 0) {
    throw new AppError("NO_LAST_TURN", "当前会话没有可删除的尾部对话。", 400);
  }

  const updated = [...messages];
  for (const index of indexes) {
    updated.splice(index, 1);
  }

  return {
    chat: updated,
    removed: {
      userMessage: analysis.user ? toDialogueRecord("", "", analysis.user.message, analysis.user.index, messages) : null,
      assistantMessage: analysis.assistant ? toDialogueRecord("", "", analysis.assistant.message, analysis.assistant.index, messages) : null,
    },
  };
}

function recordsEqual(left: HistorySyncRecord[], right: HistorySyncRecord[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return Boolean(other)
      && item.sortIndex === other.sortIndex
      && item.messageId === other.messageId
      && item.turnId === other.turnId
      && item.speaker === other.speaker
      && item.text === other.text
      && item.sendDate === other.sendDate
      && item.isUser === other.isUser;
  });
}

function isTailAppend(previous: HistorySyncRecord[], next: HistorySyncRecord[]): boolean {
  return previous.length < next.length && previous.every((item, index) => {
    const other = next[index];
    return Boolean(other)
      && item.messageId === other.messageId
      && item.turnId === other.turnId
      && item.speaker === other.speaker
      && item.text === other.text
      && item.sendDate === other.sendDate
      && item.isUser === other.isUser;
  });
}

function buildHistorySyncResultFromSnapshot(
  snapshot: HistorySyncSnapshot,
  knownRevision: number | null,
  afterSortIndex: number | null,
): HistorySyncResult {
  const latestSortIndex = snapshot.items.at(-1)?.sortIndex ?? -1;

  if (knownRevision !== null && knownRevision === snapshot.historyRevision) {
    return {
      sessionKey: snapshot.sessionKey,
      historyRevision: snapshot.historyRevision,
      mode: "unchanged",
      baseSortIndex: latestSortIndex,
      latestSortIndex,
      items: [],
    };
  }

  if (afterSortIndex !== null && afterSortIndex >= -1 && afterSortIndex < latestSortIndex) {
    return {
      sessionKey: snapshot.sessionKey,
      historyRevision: snapshot.historyRevision,
      mode: "delta",
      baseSortIndex: afterSortIndex,
      latestSortIndex,
      items: snapshot.items.filter((item) => item.sortIndex > afterSortIndex),
    };
  }

  return {
    sessionKey: snapshot.sessionKey,
    historyRevision: snapshot.historyRevision,
    mode: "full",
    baseSortIndex: -1,
    latestSortIndex,
    items: snapshot.items,
  };
}

export class ChatEditService {
  private readonly stClient: StClient;
  private readonly conversationService: ConversationService;
  private readonly sessionTaskQueue: SessionTaskQueue;
  private readonly historySyncRepository: HistorySyncRepository;

  public constructor(
    stClient: StClient,
    conversationService: ConversationService,
    sessionTaskQueue: SessionTaskQueue,
    historySyncRepository: HistorySyncRepository,
  ) {
    this.stClient = stClient;
    this.conversationService = conversationService;
    this.sessionTaskQueue = sessionTaskQueue;
    this.historySyncRepository = historySyncRepository;
  }

  public async getLastTurn(params: {
    avatar: string;
    chatFile: string;
  }): Promise<LastTurnDetails> {
    const messages = await this.stClient.getChatMessages(params.avatar, params.chatFile);
    const analysis = analyzeLastTurn(messages);
    return {
      userMessage: analysis.user ? toDialogueRecord(params.avatar, params.chatFile, analysis.user.message, analysis.user.index, messages) : null,
      assistantMessage: analysis.assistant ? toDialogueRecord(params.avatar, params.chatFile, analysis.assistant.message, analysis.assistant.index, messages) : null,
    };
  }

  public async getChatHistory(params: {
    avatar: string;
    chatFile: string;
  }): Promise<LatestDialogueRecord[]> {
    const messages = await this.stClient.getChatMessages(params.avatar, params.chatFile);
    return listDialogueRecords(params.avatar, params.chatFile, messages);
  }

  public async getChatHistorySync(params: {
    accountId: string;
    avatar: string;
    chatFile: string;
    knownRevision?: number | null;
    afterSortIndex?: number | null;
  }): Promise<HistorySyncResult> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      async () => {
        const sessionKey = buildSessionKey(params.avatar, params.chatFile);
        const knownRevision = Number.isFinite(params.knownRevision) ? Number(params.knownRevision) : null;
        const afterSortIndex = Number.isFinite(params.afterSortIndex) ? Number(params.afterSortIndex) : null;
        const cached = this.historySyncRepository.getSnapshot(sessionKey);
        const chats = await this.stClient.listCharacterChats(params.avatar);
        const chatSummary = chats.find((item) => normalizeChatFileName(item.fileId) === normalizeChatFileName(params.chatFile));
        if (!chatSummary) {
          throw new AppError("CHAT_NOT_FOUND", `未找到会话 ${params.chatFile}`, 404);
        }

        if (cached
          && cached.avatar === params.avatar
          && normalizeChatFileName(cached.chatFile) === normalizeChatFileName(params.chatFile)
          && cached.messageCount === chatSummary.messageCount
          && cached.lastMessageAt === (chatSummary.lastMessageAt ? String(chatSummary.lastMessageAt) : null)
          && cached.previewMessage === formatPreviewText(chatSummary.previewMessage ?? "")) {
          return buildHistorySyncResultFromSnapshot(cached, knownRevision, afterSortIndex);
        }

        const messages = await this.stClient.getChatMessages(params.avatar, params.chatFile);
        const records = listHistorySyncRecords(params.avatar, params.chatFile, messages);
        const previewMessage = formatPreviewText(chatSummary.previewMessage ?? records.at(-1)?.text ?? "");
        const lastMessageAt = chatSummary.lastMessageAt ? String(chatSummary.lastMessageAt) : (records.at(-1)?.sendDate ?? null);
        const contentChanged = !cached || !recordsEqual(cached.items, records);
        const updated = this.historySyncRepository.replaceSnapshot({
          sessionKey,
          avatar: params.avatar,
          chatFile: params.chatFile,
          messageCount: chatSummary.messageCount,
          lastMessageAt,
          previewMessage,
          items: records,
          incrementRevision: contentChanged,
        });

        if (cached && contentChanged && isTailAppend(cached.items, records) && afterSortIndex === cached.items.at(-1)?.sortIndex) {
          return {
            sessionKey: updated.sessionKey,
            historyRevision: updated.historyRevision,
            mode: "delta",
            baseSortIndex: afterSortIndex,
            latestSortIndex: updated.items.at(-1)?.sortIndex ?? -1,
            items: updated.items.filter((item) => item.sortIndex > afterSortIndex),
          };
        }

        return buildHistorySyncResultFromSnapshot(updated, knownRevision, afterSortIndex);
      },
    );
  }

  public async deleteLastTurn(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
  }): Promise<{ removed: LastTurnDetails; latestRecord: LatestDialogueRecord | null }> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      async () => {
        const messages = await this.stClient.getChatMessages(params.avatar, params.chatFile);
        assertChatIntact(params.avatar, params.chatFile, messages);
        const result = removeLastTurnMessages(messages);

        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: result.chat,
        });

        return {
          removed: result.removed,
          latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, result.chat),
        };
      },
    );
  }

  public async regenerateLastReply(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<{
    removedAssistant: LatestDialogueRecord | null;
    replyText: string;
    latestRecord: LatestDialogueRecord | null;
    mvuStatus: MvuStatusSnapshot | null;
  }> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      async () => {
        const originalChat = await this.stClient.getChatMessages(params.avatar, params.chatFile);
        assertChatIntact(params.avatar, params.chatFile, originalChat);

        const analysis = analyzeLastTurn(originalChat);
        const userMessage = analysis.user?.message;

        if (!userMessage || typeof userMessage.mes !== "string" || !userMessage.mes.trim()) {
          throw new AppError("NO_REDO_MESSAGE", "当前会话尾部没有可重生成的用户消息。", 400);
        }

        const trimmedChat = analysis.assistant
          ? originalChat.filter((_, index) => index !== analysis.assistant?.index)
          : originalChat;

        const result = await this.conversationService.regenerateReplyStreamWithinLock({
          accountId: params.accountId,
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          modelOverride: params.modelOverride,
          prefetchedChat: trimmedChat,
          onProgress: params.onProgress,
        });

        return {
          removedAssistant: analysis.assistant
            ? toDialogueRecord(params.avatar, params.chatFile, analysis.assistant.message, analysis.assistant.index, originalChat)
            : null,
          replyText: result.replyText,
          latestRecord: result.latestRecord,
          mvuStatus: result.mvuStatus,
        };
      },
    );
  }
}
