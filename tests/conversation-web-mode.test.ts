import { describe, expect, it, vi } from "vitest";
import type { CharacterCardDetails, ChatMessage, StGenerationSettings } from "../src/core/models/index";
import { ConversationService } from "../src/core/services/conversation-service";
import { SessionTaskQueue } from "../src/core/services/session-task-queue";
import type { WebRelayService } from "../src/core/services/web-relay-service";
import { AppError } from "../src/shared/errors/app-error";

const settings: StGenerationSettings = {
  username: "用户",
  chatCompletionSource: "custom",
  model: "model",
  customUrl: "",
  customPromptPostProcessing: "",
  temperature: 1,
  topP: 1,
  maxTokens: 1024,
};

const card: CharacterCardDetails = {
  avatar: "card.png",
  name: "角色",
  description: "",
  personality: "",
  scenario: "",
  firstMes: "开场",
  alternateGreetings: [],
  mesExample: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  worldBookEntries: [],
  mvu: null,
  xuanxiang: null,
};

const header: ChatMessage = { chat_metadata: {} };
const originalChat: ChatMessage[] = [
  header,
  { name: "角色", is_user: false, mes: "开场", extra: {} },
  { name: "用户", is_user: true, mes: "问题", extra: {} },
  { name: "角色", is_user: false, mes: "旧回复", extra: {} },
];
const generatedChat: ChatMessage[] = [
  header,
  { name: "角色", is_user: false, mes: "开场", extra: {} },
  { name: "用户", is_user: true, mes: "问题", extra: {} },
  { name: "角色", is_user: false, mes: "网页完整回复", extra: { model: "model" } },
];

function relay() {
  return {
    execute: vi.fn(async () => ({ messageIndex: 2, chatId: "chat", characterAvatar: "card.png" })),
  } as unknown as WebRelayService;
}

describe("ConversationService web prompt mode", () => {
  it("delegates a normal message to the browser without direct model generation or save", async () => {
    const webRelay = relay();
    const stClient = {
      getGenerationSettings: vi.fn(async () => structuredClone(settings)),
      getCharacterCard: vi.fn(async () => structuredClone(card)),
      getChatMessages: vi.fn(async () => structuredClone(generatedChat)),
      generateChatReply: vi.fn(),
      saveChat: vi.fn(),
    };
    const service = new ConversationService(
      stClient as never,
      new SessionTaskQueue(),
      () => "web",
      webRelay,
    );

    const result = await service.sendMessageWithinLock({
      accountId: "account",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "问题",
      modelOverride: "model",
    });

    expect(webRelay.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: "send",
      text: "问题",
      modelOverride: "model",
    }));
    expect(result.replyText).toBe("网页完整回复");
    expect(stClient.generateChatReply).not.toHaveBeenCalled();
    expect(stClient.saveChat).not.toHaveBeenCalled();
  });

  it("captures a browser-regenerated candidate and restores the original chat before returning", async () => {
    const webRelay = relay();
    const stClient = {
      getGenerationSettings: vi.fn(async () => structuredClone(settings)),
      getCharacterCard: vi.fn(async () => structuredClone(card)),
      getChatMessages: vi.fn()
        .mockResolvedValueOnce(structuredClone(originalChat))
        .mockResolvedValueOnce(structuredClone(generatedChat)),
      saveChat: vi.fn(async () => undefined),
    };
    const service = new ConversationService(
      stClient as never,
      new SessionTaskQueue(),
      () => "web",
      webRelay,
    );
    const events: string[] = [];

    const result = await service.generateReplyCandidateStreamWithinLock({
      accountId: "account",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      prefetchedChat: originalChat.slice(0, -1),
      onProgress: (event) => { events.push(event.type); },
    });

    expect(webRelay.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "regenerate" }));
    expect(result.assistantMessage.mes).toBe("网页完整回复");
    expect(stClient.saveChat).toHaveBeenCalledWith(expect.objectContaining({ chat: originalChat }));
    expect(events).toEqual(["started", "done"]);
  });

  it("refreshes a stale relay page once after its HTTP 400 and retries from the backed-up chat", async () => {
    const webRelay = {
      execute: vi.fn()
        .mockRejectedValueOnce(new AppError("WEB_RELAY_GENERATE_FAILED", "酒馆网页生成失败：Got response status 400", 502))
        .mockResolvedValueOnce({ messageIndex: 2, chatId: "chat", characterAvatar: "card.png" }),
      refreshPage: vi.fn(async () => undefined),
    } as unknown as WebRelayService;
    const stClient = {
      getGenerationSettings: vi.fn(async () => structuredClone(settings)),
      getCharacterCard: vi.fn(async () => structuredClone(card)),
      getChatMessages: vi.fn()
        .mockResolvedValueOnce(structuredClone(originalChat))
        .mockResolvedValueOnce(structuredClone(generatedChat)),
      saveChat: vi.fn(async () => undefined),
    };
    const service = new ConversationService(
      stClient as never,
      new SessionTaskQueue(),
      () => "web",
      webRelay,
    );

    const result = await service.sendMessageWithinLock({
      accountId: "account",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "问题",
    });

    expect(webRelay.refreshPage).toHaveBeenCalledWith("account");
    expect(webRelay.execute).toHaveBeenCalledTimes(2);
    expect(stClient.saveChat).toHaveBeenCalledWith(expect.objectContaining({ chat: originalChat }));
    expect(result.replyText).toBe("网页完整回复");
  });
});
