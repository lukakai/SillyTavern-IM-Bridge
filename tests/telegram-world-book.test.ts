import { describe, expect, it } from "vitest";
import type { WorldBookView } from "../src/core/models/index";
import {
  renderWorldBookChangePreview,
  renderWorldBookEntriesPage,
  renderWorldBookEntry,
  renderWorldBookPage,
} from "../src/delivery/telegram/world-book";

const book: WorldBookView = {
  id: "main-lore",
  name: "主世界书",
  revision: "abc",
  entries: [
    {
      ref: "2",
      uid: "2",
      comment: "城市设定",
      content: "旧正文",
      keys: ["银月城"],
      secondaryKeys: [],
      enabled: true,
    },
    {
      ref: "8",
      uid: "8",
      comment: "隐藏规则",
      content: "内容",
      keys: [],
      secondaryKeys: [],
      enabled: false,
    },
  ],
};

describe("Telegram world-book rendering", () => {
  it("renders paged books and entries with compact callbacks", () => {
    const books = renderWorldBookPage([
      { id: "main-lore", name: "主世界书" },
      { id: "other", name: "其他资料" },
    ], 0, 1);
    expect(books.text).toContain("主世界书");
    expect(books.keyboard.inline_keyboard.flat()).toContainEqual({ text: "1", callback_data: "wb:b:0" });
    expect(books.keyboard.inline_keyboard.flat()).toContainEqual({ text: "下一页", callback_data: "wb:bp:1" });

    const entries = renderWorldBookEntriesPage(book, 0, 8);
    expect(entries.text).toContain("🟢 [2] 城市设定");
    expect(entries.text).toContain("⚪ [8] 隐藏规则");
    expect(entries.keyboard.inline_keyboard.flat()).toContainEqual({ text: "1", callback_data: "wb:e:0" });
  });

  it("renders entry actions and a non-destructive confirmation", () => {
    const detail = renderWorldBookEntry(book, book.entries[0]);
    expect(detail.text).toContain("旧正文");
    expect(detail.keyboard.inline_keyboard.flat()).toContainEqual({ text: "✏️ 编辑正文", callback_data: "wb:edit" });

    const preview = renderWorldBookChangePreview({
      bookName: book.name,
      entry: book.entries[0],
      nextContent: "新正文",
    });
    expect(preview.text).toContain("尚未保存");
    expect(preview.text).toContain("原正文");
    expect(preview.text).toContain("新正文");
    expect(preview.keyboard.inline_keyboard.flat()).toEqual([
      { text: "✅ 确认保存", callback_data: "wb:confirm" },
      { text: "❌ 取消", callback_data: "wb:cancel" },
    ]);
  });
});
