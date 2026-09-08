import type {
  CharacterCardDetails,
  ChatMessage,
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

export { assertChatIntact };

export class ConversationService {
  private readonly stClient: StClient;
  private readonly sessionTaskQueue: SessionTaskQueue;

  public constructor(stClient: StClient, sessionTaskQueue: SessionTaskQueue) {
    this.stClient = stClient;
    this.sessionTaskQueue = sessionTaskQueue;
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

    const openAiMessages: Array<{ role: string; content: string; name?: string }> = [
      { role: "system", content: buildSystemPrompt(card, settings) },
      ...(mvuContext?.prompt ? [{ role: "system", content: mvuContext.prompt }] : []),
      ...(xuanxiangPrompt ? [{ role: "system", content: xuanxiangPrompt }] : []),
      ...toOpenAiMessages(getRecentMessages(chat), settings),
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

  private async runStream(params: {
    accountId: string;
    avatar: string;
    characterName: string;
    chatFile: string;
    text: string;
    modelOverride?: string | null;
    includeUserMessage: boolean;
    prefetchedChat?: ChatMessage[];
    onProgress?: (event: StreamEvent) => Promise<void> | void;
  }): Promise<SendMessageResult> {
    const sessionKey = buildSessionKey(params.avatar, params.chatFile);
    let previousText = "";

    try {
      await params.onProgress?.({ type: "started", sessionKey });

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

      const openAiMessages: Array<{ role: string; content: string; name?: string }> = [
        { role: "system", content: buildSystemPrompt(card, settings) },
        ...(mvuContext?.prompt ? [{ role: "system", content: mvuContext.prompt }] : []),
        ...(xuanxiangPrompt ? [{ role: "system", content: xuanxiangPrompt }] : []),
        ...toOpenAiMessages(getRecentMessages(chat), settings),
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
      const updatedChat = params.includeUserMessage
        ? [...chat, buildUserMessage(settings.username, params.text), buildAssistantMessage(params.characterName, replyText, mvu)]
        : [...chat, buildAssistantMessage(params.characterName, replyText, mvu)];

      await this.stClient.saveChat({
        avatar: params.avatar,
        characterName: params.characterName,
        chatFile: params.chatFile,
        chat: updatedChat,
      });

      const result = {
        replyText,
        latestRecord: pickLatestDialogueRecord(params.avatar, params.chatFile, updatedChat),
        mvuStatus: mvu?.status ?? null,
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
}
