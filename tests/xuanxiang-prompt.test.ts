import { describe, expect, it } from "vitest";
import type { CharacterCardDetails } from "../src/core/models/index";
import type { MvuTurnContext } from "../src/core/services/mvu-service";
import { createXuanxiangTurnPrompt } from "../src/core/services/xuanxiang-service";

function card(): CharacterCardDetails {
  return {
    avatar: "luo.png",
    name: "洛云希",
    description: "",
    personality: "",
    scenario: "",
    firstMes: "",
    alternateGreetings: [],
    mesExample: "",
    mvu: null,
    xuanxiang: {
      promptText: "<选项栏输出规范>{{user}} 与 {{char}} 使用 <xuanxiang></选项栏输出规范>",
      activationPath: ["洛云希", "协奏值"],
      activationMin: 51,
    },
  };
}

function context(concord: number): MvuTurnContext {
  return {
    snapshot: { stat_data: { 洛云希: { 协奏值: concord } } },
    prompt: null,
    rangeHints: {},
  };
}

describe("xuanxiang card prompt", () => {
  it("activates at the safely decoded MVU threshold and substitutes names", () => {
    expect(createXuanxiangTurnPrompt(card(), context(50), "哥哥")).toBeNull();
    const prompt = createXuanxiangTurnPrompt(card(), context(51), "哥哥");
    expect(prompt).toContain("哥哥 与 洛云希");
    expect(prompt).toContain("<xuanxiang>");
  });

  it("does not inject anything without the required MVU state", () => {
    expect(createXuanxiangTurnPrompt(card(), null, "哥哥")).toBeNull();
    expect(createXuanxiangTurnPrompt({ ...card(), xuanxiang: null }, context(100), "哥哥")).toBeNull();
  });
});
