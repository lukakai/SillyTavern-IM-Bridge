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
  });
});
