import type {
  CharacterCardDetails,
  ChatMessage,
  GeneratedReplyCandidate,
  PromptMode,
  SendMessageResult,
  StreamEvent,
  StGenerationSettings,
} from "../models/index";
import { AppError } from "../../shared/errors/app-error";
import { buildSessionKey, buildSessionMutationKey } from "../../shared/utils/ids";
import { pickLatestDialogueRecord } from "../../infra/st/st-chat-mapper";
import { StClient } from "../../infra/st/st-client";
import { normalizeAssistantReply, normalizeModelInputText } from "./reply-format";
import { SessionTaskQueue } from "./session-task-queue";
import {
  attachMvuSnapshot,
  createMvuTurnContext,
  processMvuReply,
  type MvuReplyResult,
} from "./mvu-service";
import { createXuanxiangTurnPrompt } from "./xuanxiang-service";
import { buildEnhancedSystemPrompt } from "./enhanced-prompt-service";
import { WebRelayService, type WebRelayOperation } from "./web-relay-service";

function substitutePlaceholders(input: string, characterName: string, userName: string): string {
  return input
    .replaceAll("{{char}}", characterName)
    .replaceAll("{{user}}", userName);
}

function sanitizeCardText(input: string, characterName: string, userName: string, maxLength: number): string {
  const substituted = substitutePlaceholders(input, characterName, userName);
  const stopMarkers = ["*重点", "nsfw", "NSFW", "18岁", "18周岁", "无内容限制"];
  let trimmed = substituted;

  for (const marker of stopMarkers) {
    const index = trimmed.indexOf(marker);
    if (index >= 0) {
      trimmed = trimmed.slice(0, index);
    }
  }

  return trimmed.slice(0, maxLength).trim();
}

function buildSystemPrompt(card: CharacterCardDetails, settings: StGenerationSettings): string {
  return [
    `你是 ${card.name}。你必须严格保持角色设定，继续当前剧情，不要跳出角色，不要写元说明。`,
    sanitizeCardText(card.description, card.name, settings.username, 2200),
    sanitizeCardText(card.personality, card.name, settings.username, 600),
    sanitizeCardText(card.scenario, card.name, settings.username, 1200),
    card.mesExample ? `示例对话：\n${sanitizeCardText(card.mesExample, card.name, settings.username, 1200)}` : "",
  ].filter(Boolean).join("\n\n");
}

function getRecentMessages(messages: ChatMessage[], limit = 24): ChatMessage[] {
  const headerRemoved = messages.slice(1);
  const digestMessages = headerRemoved.filter((message) => typeof message.mes === "string" && message.mes.startsWith("[CompressionDigest]"));
  const normalMessages = headerRemoved.filter((message) => !message.is_system);
  const recentNormalMessages = normalMessages.slice(-limit);
  return [...digestMessages.slice(0, 1), ...recentNormalMessages];
}

function toOpenAiMessages(messages: ChatMessage[], settings: StGenerationSettings): Array<{ role: string; content: string; name?: string }> {
  return messages
    .filter((message) => typeof message.mes === "string" && message.mes.trim())
    .map((message) => {
      if (message.is_system) {
        return {
          role: "system",
          content: normalizeModelInputText(String(message.mes)),
        };
      }

      return {
        role: message.is_user ? "user" : "assistant",
        name: typeof message.name === "string" && message.name.trim() ? message.name.trim() : (message.is_user ? settings.username : "Assistant"),
        content: normalizeModelInputText(typeof message.extra?.display_text === "string" && message.extra.display_text.trim()
          ? message.extra.display_text
          : String(message.mes)),
      };
    });
}

function extractAssistantReply(response: any): string {
  if (typeof response?.error?.message === "string" && response.error.message.trim()) {
    throw new AppError("GENERATE_FAILED", `生成接口返回错误: ${response.error.message.trim()}`, 502);
  }

  const message = response?.choices?.[0]?.message?.content;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  if (Array.isArray(message)) {
    const joined = message
      .map((item) => typeof item?.text === "string" ? item.text : "")
      .join("")
      .trim();
    if (joined) {
      return joined;
    }
  }

  throw new AppError("GENERATE_EMPTY", "生成响应中没有可用文本", 502);
}

function buildUserMessage(userName: string, text: string): ChatMessage {
  return {
    name: userName,
    is_user: true,
    send_date: new Date().toISOString(),
    mes: text,
    extra: {},
  };
}

function buildAssistantMessage(characterName: string, text: string, mvu: MvuReplyResult | null = null): ChatMessage {
  return attachMvuSnapshot({
    name: characterName,
    is_user: false,
    is_system: false,
    send_date: new Date().toISOString(),
    mes: text,
    extra: {},
  }, mvu?.snapshot ?? null);
}

function logMvuError(mvu: MvuReplyResult | null): void {
  if (!mvu?.error) return;
  console.warn(JSON.stringify({
    scope: "mvu",
    event: "patch_ignored",
    error: mvu.error,
  }));
}

function assertChatIntact(avatar: string, chatFile: string, chat: ChatMessage[]): void {
  if (chat.length === 0) {
    throw new AppError(
      "CHAT_READ_EMPTY",
      `读取会话为空，拒绝覆盖写入以防数据丢失。avatar=${avatar} chatFile=${chatFile}`,
      502,
    );
  }

  const header = chat[0] as Record<string, unknown> | undefined;
  if (!header || typeof (header as { chat_metadata?: unknown }).chat_metadata !== "object") {
    throw new AppError(
      "CHAT_HEADER_MISSING",
      `读取会话首行缺少 chat_metadata，拒绝覆盖写入。avatar=${avatar} chatFile=${chatFile}`,
      502,
    );
  }
}

function latestAssistantMessage(chat: ChatMessage[]): { message: ChatMessage; index: number } | null {
  for (let index = chat.length - 1; index >= 1; index -= 1) {
    const message = chat[index];
    if (message?.is_system || message?.is_user || typeof message?.mes !== "string" || !message.mes.trim()) continue;
    return { message, index };
  }
  return null;
}

function mvuStatusFromChat(
  card: CharacterCardDetails,
  chat: ChatMessage[],
  userName: string,
): import("../models/index").MvuStatusSnapshot | null {
  const context = createMvuTurnContext(card, chat, userName);
  if (!context || !context.snapshot.stat_data || typeof context.snapshot.stat_data !== "object") return null;
  return {
    statData: structuredClone(context.snapshot.stat_data as Record<string, unknown>),
    rangeHints: structuredClone(context.rangeHints),
  };
}

export { assertChatIntact };

export class ConversationService {
  private readonly stClient: StClient;
  private readonly sessionTaskQueue: SessionTaskQueue;
  private readonly resolvePromptMode: (accountId: string) => PromptMode;
  private readonly webRelayService: WebRelayService | null;

  public constructor(
    stClient: StClient,
    sessionTaskQueue: SessionTaskQueue,
    resolvePromptMode: (accountId: string) => PromptMode = () => "compact",
    webRelayService: WebRelayService | null = null,
  ) {
    this.stClient = stClient;
    this.sessionTaskQueue = sessionTaskQueue;
    this.resolvePromptMode = resolvePromptMode;
    this.webRelayService = webRelayService;
  }

  public async sendMessage(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
    modelOverride?: string | null;
  }): Promise<SendMessageResult> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      () => this.sendMessageWithinLock(params),
    );
  }

  public async sendMessageStream(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SendMessageResult> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      () => this.sendMessageStreamWithinLock(params),
    );
  }

  public async regenerateReplyStream(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SendMessageResult> {
    return this.sessionTaskQueue.runExclusive(
      buildSessionMutationKey(params.accountId, params.avatar, params.chatFile),
      () => this.regenerateReplyStreamWithinLock(params),
    );
  }

  public async sendMessageWithinLock(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
    modelOverride?: string | null;
  }): Promise<SendMessageResult> {
    if (this.resolvePromptMode(params.accountId) === "web") {
      return this.executeWebRelayWithRollback({ ...params, operation: "send" }, false);
    }

    const [settings, card, chat] = await Promise.all([
      this.stClient.getGenerationSettings(),
      this.stClient.getCharacterCard(params.avatar),
      this.stClient.getChatMessages(params.avatar, params.chatFile),
    ]);

    assertChatIntact(params.avatar, params.chatFile, chat);

    if (params.modelOverride && params.modelOverride.trim()) {
      settings.model = params.modelOverride.trim();
    }

    const mvuContext = createMvuTurnContext(card, chat, settings.username);
    const xuanxiangPrompt = createXuanxiangTurnPrompt(card, mvuContext, settings.username);
    const promptMode = this.resolvePromptMode(params.accountId);
    const systemPrompt = promptMode === "enhanced"
      ? buildEnhancedSystemPrompt({
        card,
        settings,
        chat,
        pendingUserText: params.text,
        mvuStatData: mvuContext?.snapshot.stat_data as Record<string, unknown> | undefined,
      })
      : buildSystemPrompt(card, settings);

    const openAiMessages: Array<{ role: string; content: string; name?: string }> = [
      { role: "system", content: systemPrompt },
      ...(mvuContext?.prompt ? [{ role: "system", content: mvuContext.prompt }] : []),
      ...(xuanxiangPrompt ? [{ role: "system", content: xuanxiangPrompt }] : []),
      ...toOpenAiMessages(getRecentMessages(chat, promptMode === "enhanced" ? 48 : 24), settings),
      { role: "user", name: settings.username, content: normalizeModelInputText(params.text) },
    ];

    const generated = await this.stClient.generateChatReply({
      settings,
      messages: openAiMessages,
    });

    const replyText = normalizeAssistantReply(params.characterName, extractAssistantReply(generated));
    const mvu = processMvuReply(replyText, mvuContext);
    logMvuError(mvu);
    const updatedChat = [
      ...chat,
      buildUserMessage(settings.username, params.text),
      buildAssistantMessage(params.characterName, replyText, mvu),
    ];

    await this.stClient.saveChat({
      avatar: params.avatar,
      characterName: params.characterName,
      chatFile: params.chatFile,
      chat: updatedChat,
    });

    return {
      replyText,
      latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, updatedChat),
      mvuStatus: mvu?.status ?? null,
    };
  }

  public async sendMessageStreamWithinLock(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
    modelOverride?: string | null;
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SendMessageResult> {
    return this.runStream({
      ...params,
      includeUserMessage: true,
    });
  }

  public async regenerateReplyStreamWithinLock(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    prefetchedChat?: ChatMessage[];
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SendMessageResult> {
    return this.runStream({
      ...params,
      text: "",
      includeUserMessage: false,
    });
  }

  /** Generates an assistant candidate from a caller-provided chat without saving it. */
  public async generateReplyCandidateStreamWithinLock(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    modelOverride?: string | null;
    prefetchedChat: ChatMessage[];
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<GeneratedReplyCandidate> {
    return this.runStream({
      ...params,
      text: "",
      includeUserMessage: false,
      persistChat: false,
    });
  }

  private async runStream(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
    modelOverride?: string | null;
    includeUserMessage: boolean;
    persistChat?: boolean;
    prefetchedChat?: ChatMessage[];
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<GeneratedReplyCandidate> {
    const sessionKey = buildSessionKey(params.avatar, params.chatFile);
    let previousText = "";

    try {
      await params.onProgress?.({ type: "started", sessionKey });

      if (this.resolvePromptMode(params.accountId) === "web") {
        const result = await this.executeWebRelayWithRollback({
          accountId: params.accountId,
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          text: params.text,
          modelOverride: params.modelOverride,
          operation: params.includeUserMessage ? "send" : "regenerate",
        }, params.persistChat === false);

        await params.onProgress?.({
          type: "done",
          replyText: result.replyText,
          latestRecord: result.latestRecord,
        });
        return result;
      }

      const [settings, card, fetchedChat] = await Promise.all([
        this.stClient.getGenerationSettings(),
        this.stClient.getCharacterCard(params.avatar),
        params.prefetchedChat
          ? Promise.resolve(params.prefetchedChat)
          : this.stClient.getChatMessages(params.avatar, params.chatFile),
      ]);
      const chat = fetchedChat;

      assertChatIntact(params.avatar, params.chatFile, chat);

      if (params.modelOverride && params.modelOverride.trim()) {
        settings.model = params.modelOverride.trim();
      }

      const mvuContext = createMvuTurnContext(card, chat, settings.username);
      const xuanxiangPrompt = createXuanxiangTurnPrompt(card, mvuContext, settings.username);
      const promptMode = this.resolvePromptMode(params.accountId);
      const systemPrompt = promptMode === "enhanced"
        ? buildEnhancedSystemPrompt({
          card,
          settings,
          chat,
          pendingUserText: params.includeUserMessage ? params.text : "",
          mvuStatData: mvuContext?.snapshot.stat_data as Record<string, unknown> | undefined,
        })
        : buildSystemPrompt(card, settings);

      const openAiMessages: Array<{ role: string; content: string; name?: string }> = [
        { role: "system", content: systemPrompt },
        ...(mvuContext?.prompt ? [{ role: "system", content: mvuContext.prompt }] : []),
        ...(xuanxiangPrompt ? [{ role: "system", content: xuanxiangPrompt }] : []),
        ...toOpenAiMessages(getRecentMessages(chat, promptMode === "enhanced" ? 48 : 24), settings),
      ];

      if (params.includeUserMessage) {
        openAiMessages.push({
          role: "user",
          name: settings.username,
          content: normalizeModelInputText(params.text),
        });
      }

      const generated = await this.stClient.generateChatReplyStream({
        settings,
        messages: openAiMessages,
        onProgress: async (fullText) => {
          const delta = fullText.slice(previousText.length);
          previousText = fullText;
          await params.onProgress?.({
            type: "delta",
            text: delta,
            fullText,
          });
        },
      });

      const replyText = normalizeAssistantReply(params.characterName, extractAssistantReply(generated));
      const mvu = processMvuReply(replyText, mvuContext);
      logMvuError(mvu);
      const assistantMessage = buildAssistantMessage(params.characterName, replyText, mvu);
      const updatedChat = params.includeUserMessage
        ? [...chat, buildUserMessage(settings.username, params.text), assistantMessage]
        : [...chat, assistantMessage];

      if (params.persistChat !== false) {
        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: updatedChat,
        });
      }

      const result = {
        replyText,
        latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, updatedChat),
        mvuStatus: mvu?.status ?? null,
        assistantMessage,
      };

      await params.onProgress?.({
        type: "done",
        replyText: result.replyText,
        latestRecord: result.latestRecord,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      await params.onProgress?.({ type: "error", message });
      throw error;
    }
  }

  private async executeWebRelayGeneration(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text?: string | null;
    modelOverride?: string | null;
    operation: WebRelayOperation;
  }): Promise<GeneratedReplyCandidate> {
    if (!this.webRelayService) {
      throw new AppError("WEB_RELAY_UNAVAILABLE", "当前插件未初始化网页中继服务", 503);
    }

    const completion = await this.webRelayService.execute(params);
    if (completion.characterAvatar && completion.characterAvatar !== params.avatar) {
      throw new AppError("WEB_RELAY_CHARACTER_MISMATCH", "网页中继生成后角色发生变化，已拒绝读取结果", 409);
    }
    const normalizeChatId = (value: string): string => value.replace(/\.jsonl$/i, "");
    if (completion.chatId && normalizeChatId(completion.chatId) !== normalizeChatId(params.chatFile)) {
      throw new AppError("WEB_RELAY_CHAT_MISMATCH", "网页中继生成后会话发生变化，已拒绝读取结果", 409);
    }

    const [settings, card, chat] = await Promise.all([
      this.stClient.getGenerationSettings(),
      this.stClient.getCharacterCard(params.avatar),
      this.stClient.getChatMessages(params.avatar, params.chatFile),
    ]);
    assertChatIntact(params.avatar, params.chatFile, chat);
    const assistant = latestAssistantMessage(chat);
    if (!assistant) {
      throw new AppError("WEB_RELAY_EMPTY", "网页中继完成后没有找到角色回复", 502);
    }
    if (completion.messageIndex !== null && completion.messageIndex + 1 !== assistant.index) {
      throw new AppError("WEB_RELAY_MESSAGE_MISMATCH", "网页中继返回的消息位置与酒馆记录不一致", 409);
    }

    const replyText = normalizeAssistantReply(params.characterName, String(assistant.message.mes));
    return {
      replyText,
      latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, chat),
      mvuStatus: mvuStatusFromChat(card, chat, settings.username),
      assistantMessage: structuredClone(assistant.message),
    };
  }

  private async executeWebRelayWithRollback(
    params: Parameters<ConversationService["executeWebRelayGeneration"]>[0],
    restoreAfterSuccess: boolean,
  ): Promise<GeneratedReplyCandidate> {
    const backupChat = await this.stClient.getChatMessages(params.avatar, params.chatFile);
    assertChatIntact(params.avatar, params.chatFile, backupChat);
    try {
      const result = await this.executeWebRelayGeneration(params);
      if (restoreAfterSuccess) {
        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: backupChat,
        });
      }
      return result;
    } catch (error) {
      try {
        await this.stClient.saveChat({
          avatar: params.avatar,
          characterName: params.characterName,
          chatFile: params.chatFile,
          chat: backupChat,
        });
      } catch (restoreError) {
        console.error("[st-im-bridge] failed to restore chat after web relay error", restoreError);
      }
      throw error;
    }
  }
}
