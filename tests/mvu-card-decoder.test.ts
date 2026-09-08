import { describe, expect, it } from "vitest";
import { decodeCharacterCard } from "../src/infra/st/st-decoders";

describe("decodeCharacterCard MVU metadata", () => {
  it("detects MagVarUpdate cards and extracts init, prompt and range hints", () => {
    const decoded = decodeCharacterCard([{
      avatar: "mvu.png",
      data: {
        name: "MVU角色",
        description: "角色描述",
        extensions: {
          tavern_helper: {
            scripts: [{ content: "import 'MagVarUpdate@beta'" }],
          },
        },
        character_book: {
          entries: [
            { comment: "[initvar]变量初始化勿开", enabled: false, content: "角色:\n  数值: 10" },
            {
              comment: "[mvu_update]变量更新规则",
              enabled: true,
              content: [
                "变量更新规则:",
                "  角色:",
                "    数值:",
                "      type: number",
                "      range: 0~233",
                "  ${甲|乙}.好感值:",
                "    range: 0~100",
              ].join("\n"),
            },
            { comment: "变量列表", enabled: true, content: "{{format_message_variable::stat_data}}" },
          ],
        },
      },
    }], "mvu.png");

    expect(decoded.name).toBe("MVU角色");
    expect(decoded.mvu?.initialStateText).toContain("数值: 10");
    expect(decoded.mvu?.updatePrompt).toContain("format_message_variable");
    expect(decoded.mvu?.rangeHints).toEqual({
      "/角色/数值": { min: 0, max: 233 },
      "/甲/好感值": { min: 0, max: 100 },
      "/乙/好感值": { min: 0, max: 100 },
    });
  });

  it("leaves ordinary character cards without MVU metadata", () => {
    const decoded = decodeCharacterCard([{ avatar: "normal.png", name: "普通角色" }], "normal.png");
    expect(decoded.mvu).toBeNull();
    expect(decoded.xuanxiang).toBeNull();
  });

  it("resolves referenced xuanxiang rules without executing the card EJS", () => {
    const decoded = decodeCharacterCard([{
      avatar: "luo.png",
      data: {
        name: "洛云希",
        character_book: {
          entries: [
            { comment: "选项栏总览", enabled: false, content: "选项栏能力说明" },
            { comment: "选项栏输出规范", enabled: false, content: "使用 <xuanxiang> 输出选项" },
            { comment: "异能对抗输出规范", enabled: false, content: "对抗说明" },
            { comment: "rule_互动回合与选项控制", enabled: false, content: "回合说明" },
            {
              comment: "[EJS]规则动态注入",
              enabled: true,
              content: [
                "<%_ var luoConcord = getvar('stat_data.洛云希.协奏值', { defaults: 10 }); _%>",
                "<%_ if (luoConcord >= 51) { _%>",
                "<%- await getwi(null, '选项栏输出规范') %>",
                "<%_ } _%>",
              ].join("\n"),
            },
          ],
        },
      },
    }], "luo.png");

    expect(decoded.xuanxiang?.activationPath).toEqual(["洛云希", "协奏值"]);
    expect(decoded.xuanxiang?.activationMin).toBe(51);
    expect(decoded.xuanxiang?.promptText).toContain("选项栏能力说明");
    expect(decoded.xuanxiang?.promptText).toContain("对抗说明");
    expect(decoded.xuanxiang?.promptText).not.toContain("getvar");
  });

  it("does not activate disabled xuanxiang rules without an enabled explicit injector", () => {
    const decoded = decodeCharacterCard([{
      avatar: "inactive.png",
      data: {
        name: "未启用角色",
        character_book: {
          entries: [
            { comment: "选项栏输出规范", enabled: false, content: "使用 <xuanxiang> 输出选项" },
          ],
        },
      },
    }], "inactive.png");
    expect(decoded.xuanxiang).toBeNull();
  });
});
