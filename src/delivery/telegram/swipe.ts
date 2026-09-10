import { InlineKeyboard } from "grammy";

export type TelegramSwipeAction = "add" | "replace" | "previous" | "next" | "info";

const ACTION_TOKEN: Record<TelegramSwipeAction, string> = {
  add: "a",
  replace: "r",
  previous: "p",
  next: "n",
  info: "i",
};

export function renderSwipeKeyboard(recordId: number | string, index: number, total: number): InlineKeyboard {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeIndex = Math.min(Math.max(0, Math.floor(index)), safeTotal - 1);
  const prefix = `sw:${recordId}:`;
  const keyboard = new InlineKeyboard();

  if (safeTotal > 1) {
    if (safeIndex > 0) keyboard.text("◀️", `${prefix}${ACTION_TOKEN.previous}`);
    keyboard.text(`${safeIndex + 1} / ${safeTotal}`, `${prefix}${ACTION_TOKEN.info}`);
    if (safeIndex < safeTotal - 1) keyboard.text("▶️", `${prefix}${ACTION_TOKEN.next}`);
    keyboard.row();
  }

  keyboard
    .text("♻️ 重新生成", `${prefix}${ACTION_TOKEN.replace}`)
    .text("➕ 生成备选", `${prefix}${ACTION_TOKEN.add}`)
    .row();
  return keyboard;
}

export function decodeSwipeCallback(data: string): { recordId: number; action: TelegramSwipeAction } | null {
  const match = data.match(/^sw:(\d+):([arpni])$/);
  if (!match) return null;
  const recordId = Number(match[1]);
  if (!Number.isSafeInteger(recordId) || recordId <= 0) return null;
  const actions: Record<string, TelegramSwipeAction> = {
    a: "add",
    r: "replace",
    p: "previous",
    n: "next",
    i: "info",
  };
  return { recordId, action: actions[match[2]] };
}

function keyboardRows(markup: unknown): unknown[][] {
  if (!markup || typeof markup !== "object" || Array.isArray(markup)) return [];
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  return Array.isArray(rows)
    ? rows.filter((row): row is unknown[] => Array.isArray(row) && row.length > 0)
    : [];
}

export function combineInlineKeyboards(...markups: unknown[]): { inline_keyboard: unknown[][] } | undefined {
  const rows = markups.flatMap(keyboardRows);
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}
