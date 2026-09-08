import { describe, expect, it } from "vitest";
import type { CharacterCardDetails, ChatMessage } from "../src/core/models/index";
import {
  applyMvuOperations,
  attachMvuSnapshot,
  createMvuTurnContext,
  findLatestMvuSnapshot,
  parseMvuInitialState,
  processMvuReply,
} from "../src/core/services/mvu-service";

function card(overrides: Partial<CharacterCardDetails> = {}): CharacterCardDetails {
  return {
    avatar: "card.png",
    name: "测试角色",
    description: "",
    personality: "",
    scenario: "",
    firstMes: "",
    mesExample: "",
    mvu: null,
    xuanxiang: null,
    ...overrides,
  };
}

describe("MVU state handling", () => {
  it("parses mapping-only initvar YAML and substitutes user placeholders", () => {
    const initial = [
      "世界:",
      "  时间: \"10:00\"",
      "角色:",
      "  数值: 10",
      "  锁定: false",
      "选项栏:",
      "  {{user}}选择次数: 0",
    ].join("\n");
    expect(parseMvuInitialState(initial)).toEqual({
      世界: { 时间: "10:00" },
      角色: { 数值: 10, 锁定: false },
      选项栏: { "{{user}}选择次数": 0 },
    });

    const context = createMvuTurnContext(card({
      mvu: { initialStateText: initial, updatePrompt: "", rangeHints: {} },
    }), [], "小明");
    expect(context?.snapshot.stat_data).toEqual({
      世界: { 时间: "10:00" },
      角色: { 数值: 10, 锁定: false },
      选项栏: { 小明选择次数: 0 },
    });
  });

  it("reads variables from the currently selected swipe and ignores unselected state", () => {
    const chat: ChatMessage[] = [
      { name: "角色", mes: "旧回复", swipe_id: 0, variables: [{ stat_data: { value: 1 } }] },
      {
        name: "角色",
        mes: "新回复",
        swipe_id: 1,
        variables: [
          { stat_data: { value: 2 } },
          { stat_data: { value: 3 }, schema: { type: "object" } },
        ],
      },
    ];
    expect(findLatestMvuSnapshot(chat)).toEqual({ stat_data: { value: 3 }, schema: { type: "object" } });
  });

  it("applies replace, delta, insert, remove and move atomically", () => {
    const next = applyMvuOperations({
      世界: { 时间: "10:00" },
      角色: { 数值: 10, 标签: ["旧", "保留"], 备注: "移动我" },
    }, [
      { op: "replace", path: "/世界/时间", value: "10:10" },
      { op: "delta", path: "/角色/数值", value: 2 },
      { op: "insert", path: "/角色/标签/-", value: "新增" },
      { op: "remove", path: "/角色/标签/0" },
      { op: "move", from: "/角色/备注", to: "/角色/移动后备注" },
    ]);

    expect(next).toEqual({
      世界: { 时间: "10:10" },
      角色: { 数值: 12, 标签: ["保留", "新增"], 移动后备注: "移动我" },
    });
  });

  it("keeps the previous snapshot when a patch is malformed", () => {
    const context = createMvuTurnContext(card(), [
      { mes: "回复", swipe_id: 0, variables: [{ stat_data: { 角色: { 数值: 10 } } }] },
    ], "用户");
    const result = processMvuReply([
      "正文",
      "<UpdateVariable><JSONPatch>",
      '[{"op":"delta","path":"/角色/不存在","value":1}]',
      "</JSONPatch></UpdateVariable>",
    ].join("\n"), context);

    expect(result?.appliedOperations).toBe(0);
    expect(result?.error).toContain("路径不存在");
    expect(result?.status.statData).toEqual({ 角色: { 数值: 10 } });
  });

  it("clamps updated numbers using card range hints", () => {
    const context = createMvuTurnContext(card({
      mvu: {
        initialStateText: "角色:\n  协奏值: 10",
        updatePrompt: "更新变量",
        rangeHints: { "/角色/协奏值": { min: 0, max: 233 } },
      },
    }), [], "用户");
    const result = processMvuReply([
      "正文",
      '<JSONPatch>[{"op":"delta","path":"/角色/协奏值","value":500}]</JSONPatch>',
    ].join("\n"), context);
    expect(result?.status.statData).toEqual({ 角色: { 协奏值: 233 } });
  });

  it("stores the updated snapshot in swipe-aligned message variables", () => {
    const message = attachMvuSnapshot({ name: "角色", mes: "正文" }, { stat_data: { value: 4 } });
    expect(message.swipe_id).toBe(0);
    expect(message.swipes).toEqual(["正文"]);
    expect(message.variables).toEqual([{ stat_data: { value: 4 } }]);
    expect(message.variables_initialized).toEqual([true]);
  });

  it("does nothing for a normal card and normal chat", () => {
    expect(createMvuTurnContext(card(), [{ name: "角色", mes: "普通回复" }], "用户")).toBeNull();
  });
});
