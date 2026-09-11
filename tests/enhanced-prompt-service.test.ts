import { describe, expect, it } from "vitest";
import type { CharacterCardDetails, StGenerationSettings, WorldBookEntry } from "../src/core/models/index";
import { buildEnhancedSystemPrompt } from "../src/core/services/enhanced-prompt-service";

function worldBookEntry(): WorldBookEntry {
  return {
    id: 1,
    comment: "地点资料",
    content: "{{char}}在旧校舍见过{{user}}。",
    keys: ["旧校舍"],
    secondaryKeys: [],
    enabled: true,
    constant: false,
    selective: true,
    insertionOrder: 100,
    position: "before_char",
    probability: 100,
    useProbability: true,
    selectiveLogic: 0,
    caseSensitive: false,
    matchWholeWords: false,
    scanDepth: 4,
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

describe("buildEnhancedSystemPrompt", () => {
  it("includes card instructions, persona and activated embedded world book", () => {
    const card: CharacterCardDetails = {
      avatar: "card.png",
      name: "小雪",
      description: "{{char}}的完整人物描述",
      personality: "安静",
      scenario: "校园",
      firstMes: "你好",
      alternateGreetings: [],
      mesExample: "示例",
      systemPrompt: "遵守这份角色卡规则",
      postHistoryInstructions: "回复末尾留下互动空间",
      depthPrompt: { prompt: "记住{{user}}怕冷", depth: 4, role: 0 },
      worldBookEntries: [worldBookEntry()],
      mvu: null,
      xuanxiang: null,
    };
    const settings: StGenerationSettings = {
      username: "陆安澜",
      personaDescription: "{{user}}是转学生",
      chatCompletionSource: "custom",
      model: "model",
      customUrl: "",
      customPromptPostProcessing: "",
      temperature: 1,
      topP: 1,
      maxTokens: 1024,
    };
    const prompt = buildEnhancedSystemPrompt({
      card,
      settings,
      chat: [],
      pendingUserText: "我们去旧校舍看看",
    });

    expect(prompt).toContain("遵守这份角色卡规则");
    expect(prompt).toContain("陆安澜是转学生");
    expect(prompt).toContain("小雪在旧校舍见过陆安澜");
    expect(prompt).toContain("回复末尾留下互动空间");
  });
});
