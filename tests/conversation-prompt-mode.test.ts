import { describe, expect, it, vi } from "vitest";
import type { CharacterCardDetails, StGenerationSettings, WorldBookEntry } from "../src/core/models/index";
import { ConversationService } from "../src/core/services/conversation-service";
import { SessionTaskQueue } from "../src/core/services/session-task-queue";

function worldBookEntry(): WorldBookEntry {
  return {
    id: 1,
    comment: "咖啡店",
    content: "隐藏设定：咖啡店老板认识角色。",
    keys: ["咖啡店"],
    secondaryKeys: [],
    enabled: true,
    constant: false,
    selective: true,
    insertionOrder: 100,
    position: "after_char",
    probability: 100,
    useProbability: false,
    selectiveLogic: 0,
    caseSensitive: false,
    matchWholeWords: false,
    scanDepth: null,
    preventRecursion: false,
    excludeRecursion: false,
    group: "",
    groupWeight: 100,
    ignoreBudget: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchScenario: false,
    matchCreatorNotes: false,
    matchCharacterDepthPrompt: false,
  };
}

function fixture(mode: "compact" | "enhanced") {
  const settings: StGenerationSettings = {
    username: "用户",
    personaDescription: "用户 Persona：喜欢咖啡",
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
    description: "基础描述",
    personality: "",
    scenario: "",
    firstMes: "开场",
    alternateGreetings: [],
    mesExample: "",
    systemPrompt: "角色卡系统提示",
    postHistoryInstructions: "角色卡历史后提示",
    worldBookEntries: [worldBookEntry()],
    mvu: null,
    xuanxiang: null,
  };
  const generateChatReply = vi.fn(async () => ({ choices: [{ message: { content: "回复" } }] }));
  const stClient = {
    getGenerationSettings: vi.fn(async () => structuredClone(settings)),
    getCharacterCard: vi.fn(async () => structuredClone(card)),
    getChatMessages: vi.fn(async () => [
      { chat_metadata: {} },
      { name: "角色", is_user: false, mes: "开场", extra: {} },
    ]),
    generateChatReply,
    saveChat: vi.fn(async () => undefined),
  };
  const service = new ConversationService(stClient as never, new SessionTaskQueue(), () => mode);
  return { service, generateChatReply };
}

describe("ConversationService prompt modes", () => {
  it("keeps compact mode behavior isolated from enhanced fields", async () => {
    const { service, generateChatReply } = fixture("compact");
    await service.sendMessageWithinLock({
      accountId: "account",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "去咖啡店",
    });
    const system = generateChatReply.mock.calls[0][0].messages[0].content;
    expect(system).not.toContain("隐藏设定");
    expect(system).not.toContain("角色卡系统提示");
  });

  it("loads persona, card instructions and matching world book in enhanced mode", async () => {
    const { service, generateChatReply } = fixture("enhanced");
    await service.sendMessageWithinLock({
      accountId: "account",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "去咖啡店",
    });
    const system = generateChatReply.mock.calls[0][0].messages[0].content;
    expect(system).toContain("隐藏设定：咖啡店老板认识角色");
    expect(system).toContain("用户 Persona：喜欢咖啡");
    expect(system).toContain("角色卡系统提示");
    expect(system).toContain("角色卡历史后提示");
  });
});
