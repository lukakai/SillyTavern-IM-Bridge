import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/core/models/index";
import {
  appendAssistantSwipe,
  replaceCurrentAssistantSwipe,
  selectAssistantSwipe,
} from "../src/core/services/chat-edit-service";
import { findLatestMvuSnapshot } from "../src/core/services/mvu-service";
import {
  combineInlineKeyboards,
  decodeSwipeCallback,
  renderSwipeKeyboard,
} from "../src/delivery/telegram/swipe";

function assistant(): ChatMessage {
  return {
    name: "角色",
    mes: "回复二",
    is_user: false,
    swipe_id: 1,
    swipes: ["回复一", "回复二"],
    swipe_info: [
      {
        send_date: "2026-01-01T00:00:00.000Z",
        gen_started: "2025-12-31T23:59:58.000Z",
        gen_finished: "2026-01-01T00:00:01.000Z",
        extra: { model: "m1" },
      },
      {
        send_date: "2026-01-01T00:01:00.000Z",
        gen_started: "2026-01-01T00:00:58.000Z",
        gen_finished: "2026-01-01T00:01:01.000Z",
        extra: { model: "m2" },
      },
    ],
    variables: [
      { stat_data: { 数值: 1 } },
      { stat_data: { 数值: 2 } },
    ],
    variables_initialized: [true, true],
    extra: { model: "m2" },
  };
}

function candidate(): ChatMessage {
  return {
    name: "角色",
    mes: "回复三",
    is_user: false,
    send_date: "2026-01-01T00:02:00.000Z",
    variables: [{ stat_data: { 数值: 3 } }],
    extra: { model: "m3" },
  };
}

describe("SillyTavern swipe message handling", () => {
  it("appends and selects a candidate while keeping MVU snapshots aligned", () => {
    const result = appendAssistantSwipe(assistant(), candidate());
    expect(result.index).toBe(2);
    expect(result.total).toBe(3);
    expect(result.message.mes).toBe("回复三");
    expect(result.message.swipes).toEqual(["回复一", "回复二", "回复三"]);
    expect(result.message.extra).toEqual({ model: "m3" });
    expect(findLatestMvuSnapshot([result.message])).toEqual({ stat_data: { 数值: 3 } });
  });

  it("replaces only the selected candidate", () => {
    const result = replaceCurrentAssistantSwipe(assistant(), candidate());
    expect(result.index).toBe(1);
    expect(result.total).toBe(2);
    expect(result.message.swipes).toEqual(["回复一", "回复三"]);
    expect(findLatestMvuSnapshot([result.message])).toEqual({ stat_data: { 数值: 3 } });
  });

  it("switches the selected text, metadata and MVU snapshot", () => {
    const result = selectAssistantSwipe(assistant(), 0);
    expect(result.message.mes).toBe("回复一");
    expect(result.message.swipe_id).toBe(0);
    expect(result.message.extra).toEqual({ model: "m1" });
    expect(result.message.send_date).toBe("2026-01-01T00:00:00.000Z");
    expect(result.message.gen_started).toBe("2025-12-31T23:59:58.000Z");
    expect(result.message.gen_finished).toBe("2026-01-01T00:00:01.000Z");
    expect(findLatestMvuSnapshot([result.message])).toEqual({ stat_data: { 数值: 1 } });
  });

  it("normalizes a plain assistant message into its first swipe", () => {
    const result = appendAssistantSwipe({ mes: "原回复", extra: {} }, { mes: "备选回复", extra: {} });
    expect(result.message.swipes).toEqual(["原回复", "备选回复"]);
    expect(result.message.variables).toEqual([{}, {}]);
    expect(result.message.variables_initialized).toEqual([true, true]);
  });
});

describe("Telegram swipe controls", () => {
  it("renders navigation and generation buttons with compact callbacks", () => {
    const keyboard = renderSwipeKeyboard(42, 1, 3);
    expect(keyboard.inline_keyboard.flat()).toEqual([
      { text: "◀️", callback_data: "sw:42:p" },
      { text: "2 / 3", callback_data: "sw:42:i" },
      { text: "▶️", callback_data: "sw:42:n" },
      { text: "♻️ 重新生成", callback_data: "sw:42:r" },
      { text: "➕ 生成备选", callback_data: "sw:42:a" },
    ]);
    expect(decodeSwipeCallback("sw:42:a")).toEqual({ recordId: 42, action: "add" });
    expect(decodeSwipeCallback("sw:0:a")).toBeNull();
  });

  it("combines existing branch choices with swipe controls", () => {
    expect(combineInlineKeyboards(
      { inline_keyboard: [[{ text: "A", callback_data: "branch:A" }]] },
      renderSwipeKeyboard(9, 0, 1),
    )?.inline_keyboard).toHaveLength(2);
  });
});
