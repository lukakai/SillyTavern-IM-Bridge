import { describe, expect, it } from "vitest";
import type { WorldBookEntry } from "../src/core/models/index";
import { activateWorldBook, renderWorldBookEntries } from "../src/core/services/world-book-service";

function entry(overrides: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    id: null,
    comment: "",
    content: "",
    keys: [],
    secondaryKeys: [],
    enabled: true,
    constant: false,
    selective: true,
    insertionOrder: 0,
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
    ...overrides,
  };
}

const options = { characterName: "小雪", userName: "陆安澜", random: () => 0 };

describe("activateWorldBook", () => {
  it("activates constant and keyword entries while excluding disabled entries", () => {
    const result = activateWorldBook([
      entry({ comment: "常驻", content: "常驻设定", constant: true, position: "before_char" }),
      entry({ comment: "地点", content: "图书馆很安静", keys: ["图书馆"] }),
      entry({ comment: "禁用", content: "不应出现", keys: ["图书馆"], enabled: false }),
    ], [], { ...options, pendingUserText: "去图书馆吧" });

    expect(result.beforeCharacter.map((item) => item.comment)).toEqual(["常驻"]);
    expect(result.afterCharacter.map((item) => item.comment)).toEqual(["地点"]);
  });

  it("supports secondary-key logic and bounded recursive activation", () => {
    const result = activateWorldBook([
      entry({ comment: "入口", content: "地下室里藏着旧照片", keys: ["钥匙"] }),
      entry({ comment: "递归", content: "照片属于{{char}}", keys: ["旧照片"] }),
      entry({ comment: "组合", content: "雨夜事件", keys: ["出门"], secondaryKeys: ["下雨"] }),
    ], [], { ...options, pendingUserText: "拿钥匙出门，但现在是晴天" });

    expect(result.afterCharacter.map((item) => item.comment)).toEqual(expect.arrayContaining(["入口", "递归"]));
    expect(result.afterCharacter.map((item) => item.comment)).not.toContain("组合");
    expect(renderWorldBookEntries(result.afterCharacter, "小雪", "陆安澜")).toContain("照片属于小雪");
  });

  it("honors probability, group selection and skips dynamic EJS entries", () => {
    const result = activateWorldBook([
      entry({ comment: "概率零", content: "不会出现", constant: true, useProbability: true, probability: 0 }),
      entry({ comment: "组一", content: "路线一", constant: true, group: "路线", groupWeight: 80 }),
      entry({ comment: "组二", content: "路线二", constant: true, group: "路线", groupWeight: 20 }),
      entry({ comment: "动态", content: "<%= getvar('secret') %>", constant: true }),
    ], [], options);

    expect(result.afterCharacter.map((item) => item.comment)).toEqual(["组一"]);
    expect(result.skippedDynamic).toBe(1);
  });

  it("safely materializes MVU stage if/else chains without evaluating JavaScript", () => {
    const result = activateWorldBook([
      entry({
        comment: "阶段",
        constant: true,
        content: [
          "阶段说明：",
          "<%_ if (getvar('stat_data.心理.好感度') > 80) { _%>",
          "深爱阶段",
          "<%_ } else if (getvar('stat_data.心理.好感度') > 20) { _%>",
          "信任阶段",
          "<%_ } else { _%>",
          "陌生阶段",
          "<%_ } _%>",
        ].join("\n"),
      }),
    ], [], { ...options, statData: { 心理: { 好感度: 25 } } });

    const text = renderWorldBookEntries(result.afterCharacter, "小雪", "陆安澜");
    expect(text).toContain("信任阶段");
    expect(text).not.toContain("深爱阶段");
    expect(text).not.toContain("<%");
    expect(result.skippedDynamic).toBe(0);
  });
});
