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
import { createMvuTurnContext } from "./mvu-service";
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

export interface AssistantSwipeState {
  message: ChatMessage;
  index: number;
  total: number;
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function swipeInfoFor(message: ChatMessage): Record<string, unknown> {
  const info: Record<string, unknown> = {
    send_date: typeof message.send_date === "string" ? message.send_date : new Date().toISOString(),
    extra: cloneValue(message.extra ?? {}),
  };
  if (typeof message.gen_started === "string") info.gen_started = message.gen_started;
  if (typeof message.gen_finished === "string") info.gen_finished = message.gen_finished;
  return info;
}

function normalizeAssistantSwipeState(message: ChatMessage): {
  swipes: string[];
  index: number;
  variables: unknown[];
  variablesInitialized: boolean[];
  swipeInfo: Record<string, unknown>[];
} {
  const currentText = typeof message.mes === "string" ? message.mes : "";
  const rawSwipes = Array.isArray(message.swipes) && message.swipes.every((item) => typeof item === "string")
    ? [...message.swipes] as string[]
    : [];
  const swipes = rawSwipes.length > 0 ? rawSwipes : [currentText];
  const rawIndex = Number(message.swipe_id);
  const index = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < swipes.length
    ? rawIndex
    : Math.max(0, swipes.lastIndexOf(currentText));
  swipes[index] = currentText;

  const variables = Array.isArray(message.variables)
    ? cloneValue(message.variables)
    : Array.from({ length: swipes.length }, (_, itemIndex) => itemIndex === index && message.variables
      ? cloneValue(message.variables)
      : {});
  const variablesInitialized = Array.isArray(message.variables_initialized)
    ? message.variables_initialized.map(Boolean)
    : [];
  const swipeInfo = Array.isArray(message.swipe_info)
    ? message.swipe_info.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? cloneValue(item as Record<string, unknown>)
      : {})
    : [];

  while (variables.length < swipes.length) variables.push({});
  while (variablesInitialized.length < swipes.length) variablesInitialized.push(true);
  while (swipeInfo.length < swipes.length) swipeInfo.push(swipeInfoFor(message));

  return {
    swipes,
    index,
    variables: variables.slice(0, swipes.length),
    variablesInitialized: variablesInitialized.slice(0, swipes.length),
    swipeInfo: swipeInfo.slice(0, swipes.length),
  };
}

function candidateVariable(message: ChatMessage): unknown {
  if (Array.isArray(message.variables)) return cloneValue(message.variables[0] ?? {});
  return message.variables && typeof message.variables === "object" ? cloneValue(message.variables) : {};
}

function selectNormalizedSwipe(
  original: ChatMessage,
  normalized: ReturnType<typeof normalizeAssistantSwipeState>,
  index: number,
): AssistantSwipeState {
  if (!Number.isInteger(index) || index < 0 || index >= normalized.swipes.length) {
    throw new AppError("SWIPE_NOT_FOUND", "这个备选回复不存在。", 400);
  }
  const info = normalized.swipeInfo[index] ?? {};
  const infoExtra = info.extra;
  const extra = infoExtra && typeof infoExtra === "object" && !Array.isArray(infoExtra)
    ? cloneValue(infoExtra as Record<string, unknown>)
    : {};
  const sendDate = typeof info.send_date === "string" ? info.send_date : original.send_date;
  const selectedMessage: ChatMessage = {
    ...original,
    mes: normalized.swipes[index],
    swipe_id: index,
    swipes: normalized.swipes,
    swipe_info: normalized.swipeInfo,
    variables: normalized.variables,
    variables_initialized: normalized.variablesInitialized,
    extra,
    ...(sendDate ? { send_date: sendDate } : {}),
  };
  for (const key of ["gen_started", "gen_finished"] as const) {
    if (typeof info[key] === "string") selectedMessage[key] = info[key];
    else delete selectedMessage[key];
  }
  return {
    message: selectedMessage,
    index,
    total: normalized.swipes.length,
  };
}

export function appendAssistantSwipe(original: ChatMessage, candidate: ChatMessage): AssistantSwipeState {
  const normalized = normalizeAssistantSwipeState(original);
  normalized.swipes.push(String(candidate.mes ?? ""));
  normalized.variables.push(candidateVariable(candidate));
  normalized.variablesInitialized.push(true);
  normalized.swipeInfo.push(swipeInfoFor(candidate));
  return selectNormalizedSwipe(original, normalized, normalized.swipes.length - 1);
}

export function replaceCurrentAssistantSwipe(original: ChatMessage, candidate: ChatMessage): AssistantSwipeState {
  const normalized = normalizeAssistantSwipeState(original);
  normalized.swipes[normalized.index] = String(candidate.mes ?? "");
  normalized.variables[normalized.index] = candidateVariable(candidate);
  normalized.variablesInitialized[normalized.index] = true;
  normalized.swipeInfo[normalized.index] = swipeInfoFor(candidate);
  return selectNormalizedSwipe(original, normalized, normalized.index);
}

export function selectAssistantSwipe(original: ChatMessage, index: number): AssistantSwipeState {
  return selectNormalizedSwipe(original, normalizeAssistantSwipeState(original), index);
}

function mvuStatusForSelectedMessage(
  card: Awaited<ReturnType<StClient["getCharacterCard"]>>,
  chat: ChatMessage[],
  userName: string,
): MvuStatusSnapshot | null {
  const context = createMvuTurnContext(card, chat, userName);
  if (!context || !context.snapshot.stat_data || typeof context.snapshot.stat_data !== "object") return null;
  return {
    statData: cloneValue(context.snapshot.stat_data as Record<string, unknown>),
    rangeHints: cloneValue(context.rangeHints),
  };
}

export interface SwipeReplyResult {
  replyText: string;
  latestRecord: LatestDialogueRecord | null;
  mvuStatus: MvuStatusSnapshot | null;
  swipeIndex: number;
  swipeCount: number;
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

  public async editLatestUserMessage(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
  }): Promise<{ swipeIndex: number; swipeCount: number }> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      async () => {
        const messages = await this.stClient.getChatMessages(params.avatar, params.chatFile);
        assertChatIntact(params.avatar, params.chatFile, messages);
        const analysis = analyzeLastTurn(messages);
        if (!analysis.user) {
          throw new AppError("NO_EDITABLE_MESSAGE", "当前会话没有可编辑的最新用户消息。", 400);
        }

        const text = params.text.trim();
        if (!text) throw new AppError("EDIT_MESSAGE_EMPTY", "编辑后的消息不能为空。", 400);
        const extra = { ...(analysis.user.message.extra ?? {}) };
        delete extra.display_text;
        const updatedChat = messages.map((message, index) => index === analysis.user!.index
          ? { ...message, mes: text, extra }
          : message);

        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: updatedChat,
        });

        if (!analysis.assistant) return { swipeIndex: 0, swipeCount: 0 };
        const swipe = normalizeAssistantSwipeState(analysis.assistant.message);
        return { swipeIndex: swipe.index, swipeCount: swipe.swipes.length };
      },
    );
  }

  public async appendLastReplySwipe(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SwipeReplyResult> {
    return this.generateLastReplySwipe(params, "append");
  }

  public async replaceLastReplySwipe(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SwipeReplyResult> {
    return this.generateLastReplySwipe(params, "replace");
  }

  private async generateLastReplySwipe(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }, mode: "append" | "replace"): Promise<SwipeReplyResult> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      async () => {
        const originalChat = await this.stClient.getChatMessages(params.avatar, params.chatFile);
        assertChatIntact(params.avatar, params.chatFile, originalChat);
        const analysis = analyzeLastTurn(originalChat);
        if (!analysis.user || typeof analysis.user.message.mes !== "string" || !analysis.user.message.mes.trim()) {
          throw new AppError("NO_REDO_MESSAGE", "当前会话尾部没有可重生成的用户消息。", 400);
        }
        if (!analysis.assistant) {
          throw new AppError("NO_SWIPE_REPLY", "当前会话尾部没有可生成备选的角色回复。", 400);
        }

        const current = normalizeAssistantSwipeState(analysis.assistant.message);
        if (mode === "append" && current.swipes.length >= 20) {
          throw new AppError("SWIPE_LIMIT", "当前回复已有 20 个备选，请先使用现有备选。", 400);
        }
        const promptChat = originalChat.filter((_, index) => index !== analysis.assistant!.index);
        const candidate = await this.conversationService.generateReplyCandidateStreamWithinLock({
          accountId: params.accountId,
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          modelOverride: params.modelOverride,
          prefetchedChat: promptChat,
          onProgress: params.onProgress,
        });
        const swipe = mode === "append"
          ? appendAssistantSwipe(analysis.assistant.message, candidate.assistantMessage)
          : replaceCurrentAssistantSwipe(analysis.assistant.message, candidate.assistantMessage);
        const updatedChat = originalChat.map((message, index) => index === analysis.assistant!.index ? swipe.message : message);

        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: updatedChat,
        });

        return {
          replyText: String(swipe.message.mes ?? ""),
          latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, updatedChat),
          mvuStatus: candidate.mvuStatus,
          swipeIndex: swipe.index,
          swipeCount: swipe.total,
        };
      },
    );
  }

  public async selectLastReplySwipe(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    swipeIndex: number;
  }): Promise<SwipeReplyResult> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      async () => {
        const [messages, card, settings] = await Promise.all([
          this.stClient.getChatMessages(params.avatar, params.chatFile),
          this.stClient.getCharacterCard(params.avatar),
          this.stClient.getGenerationSettings(),
        ]);
        assertChatIntact(params.avatar, params.chatFile, messages);
        const analysis = analyzeLastTurn(messages);
        if (!analysis.assistant) {
          throw new AppError("NO_SWIPE_REPLY", "当前会话尾部没有可切换的角色回复。", 400);
        }
        const swipe = selectAssistantSwipe(analysis.assistant.message, params.swipeIndex);
        const updatedChat = messages.map((message, index) => index === analysis.assistant!.index ? swipe.message : message);
        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: updatedChat,
        });
        return {
          replyText: String(swipe.message.mes ?? ""),
          latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, updatedChat),
          mvuStatus: mvuStatusForSelectedMessage(card, updatedChat, settings.username),
          swipeIndex: swipe.index,
          swipeCount: swipe.total,
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
