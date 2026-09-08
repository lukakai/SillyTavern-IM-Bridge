import { describe, expect, it } from "vitest";
import {
  applyXuanxiangAction,
  createStoredXuanxiang,
  decodeStoredXuanxiang,
  decodeXuanxiangCallback,
  extractXuanxiang,
  formatXuanxiangSelection,
  renderXuanxiangPanel,
} from "../src/delivery/telegram/xuanxiang";

describe("Telegram xuanxiang interactions", () => {
  it("strictly parses every supported option state and resolves its selection text", () => {
    const first = extractXuanxiang([
      "剧情上半段。",
      "<xuanxiang>",
      "[A|normal|普通行动]",
      "[B|deleted|划掉的行动|不准选！|好吧好吧]",
      "[C|modified|原始行动|修改后行动]",
      "[D|hidden|隐藏行动]",
      "[E|blink|推开她|抱住她|最终抱住她]",
      "[F|forced|我替你选啦(ᐢ ᴗ ᐢ)|安全行动]",
      "</xuanxiang>",
      "剧情下半段。",
    ].join("\n"));
    const second = extractXuanxiang([
      "<xuanxiang>",
      "[A|urgent|马上道歉|10|快点啦]",
      "[B|mystery|神秘行动|不给你看]",
      "</xuanxiang>",
    ].join("\n"));

    expect(first.text).toBe("剧情上半段。\n\n剧情下半段。");
    expect(first.options?.map((option) => [option.letter, option.status, option.selectionText])).toEqual([
      ["A", "normal", "普通行动"],
      ["B", "deleted", "划掉的行动"],
      ["C", "modified", "修改后行动"],
      ["D", "hidden", "隐藏行动"],
      ["E", "blink", "最终抱住她"],
      ["F", "forced", "安全行动"],
    ]);
    expect(second.options?.map((option) => [option.status, option.selectionText])).toEqual([
      ["urgent", "马上道歉"],
      ["mystery", "神秘行动"],
    ]);
  });

  it("leaves malformed or unrelated card text unchanged", () => {
    const malformed = "普通卡正文\n<xuanxiang>[A|unknown|内容]</xuanxiang>";
    expect(extractXuanxiang(malformed)).toEqual({ text: malformed, options: null });
    expect(createStoredXuanxiang("普通卡正文")).toBeNull();
  });

  it("requires five deleted clicks before selection", () => {
    const stored = createStoredXuanxiang("<xuanxiang>[A|deleted|牵住她|不许选|随你啦]</xuanxiang>")!;
    let state = stored.state;
    for (let index = 1; index <= 5; index += 1) {
      const result = applyXuanxiangAction(stored.options, state, "A", "unlock");
      state = result.state;
      expect(state.deletedClicks.A).toBe(index);
      expect(result.selected).toBeNull();
    }
    const selected = applyXuanxiangAction(stored.options, state, "A", "select");
    expect(selected.selected?.selectionText).toBe("牵住她");
    expect(formatXuanxiangSelection(selected.selected!)).toBe("*(选择了：A - 牵住她)*");
  });

  it("uses two-stage reveal for hidden and mystery options", () => {
    const stored = createStoredXuanxiang([
      "<xuanxiang>",
      "[A|hidden|偷偷靠近她]",
      "[B|mystery|摸摸她的头|不给你看]",
      "</xuanxiang>",
    ].join("\n"))!;
    expect(() => applyXuanxiangAction(stored.options, stored.state, "A", "select")).toThrow("先揭晓");
    const revealed = applyXuanxiangAction(stored.options, stored.state, "A", "reveal");
    const panel = renderXuanxiangPanel(stored.options, revealed.state, "42");
    expect(panel.text).toContain("A. 🔓 偷偷靠近她");
    expect(panel.keyboard?.inline_keyboard.flat()).toContainEqual({ text: "A · 选择", callback_data: "xq:42:A:s" });
    expect(applyXuanxiangAction(stored.options, revealed.state, "A", "select").selected?.selectionText).toBe("偷偷靠近她");
  });

  it("maps forced paper to accept or uncover without exposing other choices first", () => {
    const stored = createStoredXuanxiang([
      "<xuanxiang>",
      "[A|normal|另一个行动]",
      "[F|forced|这个最正常啦(¬_¬)|陪她练琴]",
      "</xuanxiang>",
    ].join("\n"))!;
    const initial = renderXuanxiangPanel(stored.options, stored.state, "7");
    expect(initial.text).not.toContain("另一个行动");
    expect(initial.keyboard?.inline_keyboard.flat()).toEqual([
      { text: "F · 接受纸条", callback_data: "xq:7:F:s" },
      { text: "掀开纸条", callback_data: "xq:7:F:u" },
    ]);
    const uncovered = applyXuanxiangAction(stored.options, stored.state, "F", "uncover");
    expect(renderXuanxiangPanel(stored.options, uncovered.state, "7").text).toContain("另一个行动");
    expect(applyXuanxiangAction(stored.options, stored.state, "F", "select").selected?.selectionText).toBe("陪她练琴");
  });

  it("keeps urgent choices manual and selects modified/blink final text", () => {
    const stored = createStoredXuanxiang([
      "<xuanxiang>",
      "[A|urgent|立刻道歉|3|就现在]",
      "[B|modified|离开房间|留下陪她]",
      "[C|blink|推开她|抱紧她|紧紧抱住她]",
      "</xuanxiang>",
    ].join("\n"))!;
    const panel = renderXuanxiangPanel(stored.options, stored.state, "99");
    expect(panel.text).toContain("原设定 3 秒；TG 中不限时");
    expect(panel.keyboard?.inline_keyboard.flat()).toContainEqual({ text: "A · 选择", callback_data: "xq:99:A:s" });
    expect(applyXuanxiangAction(stored.options, stored.state, "B", "select").selected?.selectionText).toBe("留下陪她");
    expect(applyXuanxiangAction(stored.options, stored.state, "C", "select").selected?.selectionText).toBe("紧紧抱住她");
  });

  it("validates persisted data and compact callback tokens", () => {
    const stored = createStoredXuanxiang("<xuanxiang>[A|normal|继续聊天]</xuanxiang>")!;
    expect(decodeStoredXuanxiang(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(decodeStoredXuanxiang({ version: 1, options: [{ letter: "Z" }], state: {} })).toBeNull();
    expect(decodeXuanxiangCallback("xq:123:A:s")).toEqual({ recordId: 123, letter: "A", action: "select" });
    expect(decodeXuanxiangCallback("xq:0:A:s")).toBeNull();
  });
});
