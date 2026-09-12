import { InlineKeyboard } from "grammy";
import type { WorldBookEntryView, WorldBookSummary, WorldBookView } from "../../core/models/index";

function oneLine(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function entryLabel(entry: WorldBookEntryView): string {
  return oneLine(entry.comment || entry.keys.join("、") || `条目 ${entry.uid}`, 80);
}

function entryStatus(entry: WorldBookEntryView): string {
  return !entry.enabled ? "⚪" : entry.constant ? "🔵" : "🟢";
}

function entryMode(entry: WorldBookEntryView): string {
  return entry.constant ? "🔵 蓝灯（常驻触发）" : "🟢 绿灯（关键词触发）";
}

function excerpt(value: string, maxLength = 900): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n……（共 ${value.length} 字符）`;
}

export function renderWorldBookPage(
  books: WorldBookSummary[],
  page: number,
  pageSize: number,
  searchLabel = "",
): { text: string; keyboard: InlineKeyboard; safePage: number } {
  const totalPages = Math.max(1, Math.ceil(books.length / pageSize));
  const safePage = Math.min(Math.max(Math.floor(page), 0), totalPages - 1);
  const offset = safePage * pageSize;
  const items = books.slice(offset, offset + pageSize);
  const lines = [searchLabel ? `独立世界书搜索：${searchLabel}` : "请选择独立世界书：", ""];
  if (items.length === 0) lines.push("没有匹配的世界书。", "");
  items.forEach((book, index) => {
    lines.push(`${offset + index + 1}. ${book.name}${book.id === book.name ? "" : ` (${book.id})`}`);
  });
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);
  if (!searchLabel) lines.push("提示：可使用 /worldbook 关键词 搜索世界书。");

  const keyboard = new InlineKeyboard();
  items.forEach((_book, index) => {
    keyboard.text(String(offset + index + 1), `wb:b:${offset + index}`);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  if (safePage > 0) keyboard.text("上一页", `wb:bp:${safePage - 1}`);
  if (safePage < totalPages - 1) keyboard.text("下一页", `wb:bp:${safePage + 1}`);
  return { text: lines.join("\n"), keyboard, safePage };
}

export function renderWorldBookEntriesPage(
  book: WorldBookView,
  page: number,
  pageSize: number,
  searchLabel = "",
): { text: string; keyboard: InlineKeyboard; safePage: number } {
  const totalPages = Math.max(1, Math.ceil(book.entries.length / pageSize));
  const safePage = Math.min(Math.max(Math.floor(page), 0), totalPages - 1);
  const offset = safePage * pageSize;
  const items = book.entries.slice(offset, offset + pageSize);
  const lines = [
    `世界书：${book.name}`,
    searchLabel ? `条目搜索：${searchLabel}` : `共 ${book.entries.length} 个条目`,
    "",
  ];
  if (items.length === 0) lines.push("没有匹配的条目。", "");
  items.forEach((entry, index) => {
    const keys = entry.keys.length ? `｜关键词：${oneLine(entry.keys.join("、"), 50)}` : "";
    lines.push(`${offset + index + 1}. ${entryStatus(entry)} [${entry.uid}] ${entryLabel(entry)}${keys}`);
  });
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);
  lines.push("使用 /wbfind 关键词 搜索当前世界书的条目。");

  const keyboard = new InlineKeyboard();
  items.forEach((_entry, index) => {
    keyboard.text(String(offset + index + 1), `wb:e:${offset + index}`);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  if (safePage > 0) keyboard.text("上一页", `wb:ep:${safePage - 1}`);
  if (safePage < totalPages - 1) keyboard.text("下一页", `wb:ep:${safePage + 1}`);
  if (safePage > 0 || safePage < totalPages - 1) keyboard.row();
  keyboard.text("⬅️ 返回世界书", "wb:books");
  return { text: lines.join("\n"), keyboard, safePage };
}

export function renderWorldBookEntry(book: WorldBookView, entry: WorldBookEntryView): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    `世界书：${book.name}`,
    `条目：[${entry.uid}] ${entryLabel(entry)}`,
    `状态：${entry.enabled ? "已启用" : "⚪ 已禁用"}`,
    `触发模式：${entryMode(entry)}`,
    `主关键词：${entry.keys.length ? entry.keys.join("、") : "无"}`,
    `次关键词：${entry.secondaryKeys.length ? entry.secondaryKeys.join("、") : "无"}`,
    `正文长度：${entry.content.length} 字符`,
    "",
    "—— 正文 ——",
    entry.content ? excerpt(entry.content, 12_000) : "（空）",
  ];
  const keyboard = new InlineKeyboard()
    .text("✏️ 编辑正文", "wb:edit")
    .text(entry.enabled ? "⏸ 禁用" : "▶️ 启用", "wb:toggle")
    .row()
    .text(entry.constant ? "🟢 改为绿灯" : "🔵 改为蓝灯", "wb:mode")
    .row()
    .text("⬅️ 返回条目", "wb:entries")
    .text("📚 世界书列表", "wb:books");
  return { text: lines.join("\n"), keyboard };
}

export function renderWorldBookChangePreview(params: {
  bookName: string;
  entry: WorldBookEntryView;
  nextContent?: string;
  nextEnabled?: boolean;
  nextConstant?: boolean;
}): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    "⚠️ 尚未保存，请确认修改",
    `世界书：${params.bookName}`,
    `条目：[${params.entry.uid}] ${entryLabel(params.entry)}`,
    "",
  ];
  if (typeof params.nextContent === "string") {
    lines.push(
      `原正文（${params.entry.content.length} 字符）：`,
      excerpt(params.entry.content),
      "",
      `新正文（${params.nextContent.length} 字符）：`,
      excerpt(params.nextContent),
    );
  }
  if (typeof params.nextEnabled === "boolean") {
    lines.push(`状态：${params.entry.enabled ? "启用" : "禁用"} → ${params.nextEnabled ? "启用" : "禁用"}`);
  }
  if (typeof params.nextConstant === "boolean") {
    lines.push(`触发模式：${entryMode(params.entry)} → ${params.nextConstant ? "🔵 蓝灯（常驻触发）" : "🟢 绿灯（关键词触发）"}`);
    if (!params.nextConstant && params.entry.keys.length === 0) {
      lines.push("⚠️ 该条目没有主关键词，改为绿灯后通常不会被触发。请先在酒馆网页端设置关键词。");
    }
    if (!params.entry.enabled) lines.push("提示：该条目当前已禁用，切换模式不会自动启用。");
  }
  lines.push("", "确认后会先在插件 data/world-book-backups 中保存备份，再写入 SillyTavern。");
  const keyboard = new InlineKeyboard()
    .text("✅ 确认保存", "wb:confirm")
    .text("❌ 取消", "wb:cancel");
  return { text: lines.join("\n"), keyboard };
}
