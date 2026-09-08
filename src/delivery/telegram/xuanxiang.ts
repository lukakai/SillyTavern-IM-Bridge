import { InlineKeyboard } from "grammy";

export type XuanxiangStatus =
  | "normal"
  | "deleted"
  | "modified"
  | "hidden"
  | "forced"
  | "blink"
  | "urgent"
  | "mystery";

export type XuanxiangAction = "select" | "unlock" | "reveal" | "uncover";

export interface XuanxiangOption {
  letter: string;
  status: XuanxiangStatus;
  fields: string[];
  selectionText: string;
}

export interface XuanxiangInteractionState {
  deletedClicks: Record<string, number>;
  revealed: string[];
  forcedUncovered: boolean;
  selectedLetter: string | null;
}

export interface StoredXuanxiang {
  version: 1;
  options: XuanxiangOption[];
  state: XuanxiangInteractionState;
}

export interface XuanxiangExtraction {
  text: string;
  options: XuanxiangOption[] | null;
}

export interface XuanxiangPanel {
  text: string;
  keyboard: InlineKeyboard | null;
}

export interface XuanxiangActionResult {
  state: XuanxiangInteractionState;
  selected: XuanxiangOption | null;
  notice: string;
}

const STATUS_SET = new Set<XuanxiangStatus>([
  "normal",
  "deleted",
  "modified",
  "hidden",
  "forced",
  "blink",
  "urgent",
  "mystery",
]);

const EXPECTED_FIELD_COUNTS: Record<XuanxiangStatus, number> = {
  normal: 1,
  deleted: 3,
  modified: 2,
  hidden: 1,
  forced: 2,
  blink: 3,
  urgent: 3,
  mystery: 2,
};

const ACTION_TOKEN: Record<XuanxiangAction, string> = {
  select: "s",
  unlock: "d",
  reveal: "r",
  uncover: "u",
};

const MAX_BLOCK_LENGTH = 8000;
const MAX_FIELD_LENGTH = 500;

function normalizeField(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function selectionText(status: XuanxiangStatus, fields: string[]): string {
  switch (status) {
    case "modified":
    case "forced":
      return fields[1];
    case "blink":
      return fields[2];
    default:
      return fields[0];
  }
}

function parseOptionsBody(body: string): XuanxiangOption[] | null {
  if (body.length > MAX_BLOCK_LENGTH) return null;
  const itemPattern = /\[([A-F])\|(normal|deleted|modified|hidden|forced|blink|urgent|mystery)\|([^\]]+)\]/gi;
  const matches = [...body.matchAll(itemPattern)];
  if (matches.length === 0 || matches.length > 6) return null;
  if (body.replace(itemPattern, "").trim()) return null;

  const letters = new Set<string>();
  const options: XuanxiangOption[] = [];
  for (const match of matches) {
    const letter = match[1].toUpperCase();
    const status = match[2].toLowerCase() as XuanxiangStatus;
    const fields = match[3].split("|").map(normalizeField);
    if (letters.has(letter) || fields.length !== EXPECTED_FIELD_COUNTS[status]) return null;
    if (fields.some((field) => !field || field.length > MAX_FIELD_LENGTH)) return null;
    if (status === "urgent" && (!/^\d{1,3}$/.test(fields[1]) || Number(fields[1]) <= 0)) return null;
    if (status === "forced" && letter !== "F") return null;
    letters.add(letter);
    options.push({ letter, status, fields, selectionText: selectionText(status, fields) });
  }

  return options;
}

/** Extracts one strictly valid xuanxiang block and leaves malformed blocks untouched. */
export function extractXuanxiang(rawText: string): XuanxiangExtraction {
  const blockPattern = /<xuanxiang\b[^>]*>([\s\S]*?)<\/xuanxiang>/i;
  const match = blockPattern.exec(rawText);
  if (!match) return { text: rawText, options: null };
  const options = parseOptionsBody(match[1]);
  if (!options) return { text: rawText, options: null };
  const text = `${rawText.slice(0, match.index)}${rawText.slice(match.index + match[0].length)}`
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
  return { text, options };
}

export function createXuanxiangState(): XuanxiangInteractionState {
  return {
    deletedClicks: {},
    revealed: [],
    forcedUncovered: false,
    selectedLetter: null,
  };
}

export function createStoredXuanxiang(rawText: string): StoredXuanxiang | null {
  const options = extractXuanxiang(rawText).options;
  return options ? { version: 1, options, state: createXuanxiangState() } : null;
}

function decodeOption(value: unknown): XuanxiangOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const option = value as Record<string, unknown>;
  const letter = typeof option.letter === "string" ? option.letter.toUpperCase() : "";
  const status = typeof option.status === "string" ? option.status.toLowerCase() as XuanxiangStatus : "" as XuanxiangStatus;
  const fields = Array.isArray(option.fields) ? option.fields.map((field) => typeof field === "string" ? normalizeField(field) : "") : [];
  if (!/^[A-F]$/.test(letter) || !STATUS_SET.has(status)) return null;
  if (fields.length !== EXPECTED_FIELD_COUNTS[status] || fields.some((field) => !field || field.length > MAX_FIELD_LENGTH)) return null;
  if (status === "urgent" && (!/^\d{1,3}$/.test(fields[1]) || Number(fields[1]) <= 0)) return null;
  if (status === "forced" && letter !== "F") return null;
  return { letter, status, fields, selectionText: selectionText(status, fields) };
}

/** Validates persisted interaction data before it is used by callback handlers. */
export function decodeStoredXuanxiang(value: unknown): StoredXuanxiang | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (stored.version !== 1 || !Array.isArray(stored.options) || stored.options.length === 0 || stored.options.length > 6) return null;
  const options = stored.options.map(decodeOption);
  if (options.some((option) => !option)) return null;
  const validOptions = options as XuanxiangOption[];
  if (new Set(validOptions.map((option) => option.letter)).size !== validOptions.length) return null;

  const rawState = stored.state;
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) return null;
  const stateRecord = rawState as Record<string, unknown>;
  const validLetters = new Set(validOptions.map((option) => option.letter));
  const rawClicks = stateRecord.deletedClicks;
  const deletedClicks: Record<string, number> = {};
  if (rawClicks && typeof rawClicks === "object" && !Array.isArray(rawClicks)) {
    for (const [letter, count] of Object.entries(rawClicks as Record<string, unknown>)) {
      if (validLetters.has(letter) && Number.isInteger(count) && Number(count) >= 0 && Number(count) <= 5) {
        deletedClicks[letter] = Number(count);
      }
    }
  }
  const revealed = Array.isArray(stateRecord.revealed)
    ? [...new Set(stateRecord.revealed.filter((letter): letter is string => typeof letter === "string" && validLetters.has(letter)))]
    : [];
  const selectedLetter = typeof stateRecord.selectedLetter === "string" && validLetters.has(stateRecord.selectedLetter)
    ? stateRecord.selectedLetter
    : null;

  return {
    version: 1,
    options: validOptions,
    state: {
      deletedClicks,
      revealed,
      forcedUncovered: stateRecord.forcedUncovered === true,
      selectedLetter,
    },
  };
}

function displayText(input: string, maxLength = 180): string {
  return input.length > maxLength ? `${input.slice(0, maxLength - 1)}…` : input;
}

function optionLine(option: XuanxiangOption, state: XuanxiangInteractionState): string {
  const [first, second = "", third = ""] = option.fields.map((field) => displayText(field));
  switch (option.status) {
    case "deleted": {
      const clicks = state.deletedClicks[option.letter] ?? 0;
      const note = clicks >= 5 ? third : second;
      return `${option.letter}. 🚫 ${first}（解锁 ${clicks}/5${note ? `；${note}` : ""}）`;
    }
    case "modified":
      return `${option.letter}. ✍️ ${first} → ${second}`;
    case "hidden":
      return state.revealed.includes(option.letter)
        ? `${option.letter}. 🔓 ${first}`
        : `${option.letter}. 🪄 ▒▒▒ 隐藏选项（先揭晓）`;
    case "forced":
      return `${option.letter}. 📝 ${first}`;
    case "blink":
      return `${option.letter}. ✨ ${first} ⇄ ${second}`;
    case "urgent":
      return `${option.letter}. ⚠️ ${first}（原设定 ${second} 秒；TG 中不限时）${third ? ` · ${third}` : ""}`;
    case "mystery":
      return state.revealed.includes(option.letter)
        ? `${option.letter}. 🎭 ${first}`
        : `${option.letter}. 🎭 #@!*&$（先揭晓）${second ? ` · ${second}` : ""}`;
    default:
      return `${option.letter}. ${first}`;
  }
}

function callbackData(callbackId: string, option: XuanxiangOption, action: XuanxiangAction): string {
  return `xq:${callbackId}:${option.letter}:${ACTION_TOKEN[action]}`;
}

function button(keyboard: InlineKeyboard, label: string, data: string): void {
  keyboard.text(label, data).row();
}

export function renderXuanxiangPanel(
  options: XuanxiangOption[],
  state: XuanxiangInteractionState,
  callbackId: string | null,
): XuanxiangPanel {
  const selected = state.selectedLetter
    ? options.find((option) => option.letter === state.selectedLetter) ?? null
    : null;
  const forced = options.find((option) => option.status === "forced") ?? null;
  const visibleOptions = forced && !state.forcedUncovered ? [forced] : options;
  const lines = ["🎼 指尖余音", "", ...visibleOptions.map((option) => optionLine(option, state))];
  if (forced && !state.forcedUncovered && !selected) {
    lines.push("", "洛云希用纸条盖住了其他选项：可以接受，也可以掀开。");
  }
  if (selected) {
    lines.push("", `✅ 已选择：${selected.letter} - ${selected.selectionText}`);
  } else if (!callbackId) {
    lines.push("", "当前选项只能作为文本查看。");
  }

  if (!callbackId || selected) return { text: lines.join("\n").trim(), keyboard: null };
  const keyboard = new InlineKeyboard();
  if (forced && !state.forcedUncovered) {
    keyboard
      .text(`${forced.letter} · 接受纸条`, callbackData(callbackId, forced, "select"))
      .text("掀开纸条", callbackData(callbackId, forced, "uncover"))
      .row();
    return { text: lines.join("\n").trim(), keyboard };
  }

  for (const option of options) {
    if (option.status === "deleted" && (state.deletedClicks[option.letter] ?? 0) < 5) {
      button(keyboard, `${option.letter} · 解锁 ${state.deletedClicks[option.letter] ?? 0}/5`, callbackData(callbackId, option, "unlock"));
    } else if ((option.status === "hidden" || option.status === "mystery") && !state.revealed.includes(option.letter)) {
      button(keyboard, `${option.letter} · 揭晓`, callbackData(callbackId, option, "reveal"));
    } else {
      button(keyboard, `${option.letter} · 选择`, callbackData(callbackId, option, "select"));
    }
  }
  return { text: lines.join("\n").trim(), keyboard };
}

function cloneState(state: XuanxiangInteractionState): XuanxiangInteractionState {
  return {
    deletedClicks: { ...state.deletedClicks },
    revealed: [...state.revealed],
    forcedUncovered: state.forcedUncovered,
    selectedLetter: state.selectedLetter,
  };
}

export function applyXuanxiangAction(
  options: XuanxiangOption[],
  currentState: XuanxiangInteractionState,
  letter: string,
  action: XuanxiangAction,
): XuanxiangActionResult {
  const option = options.find((candidate) => candidate.letter === letter.toUpperCase());
  if (!option) throw new Error("这个选项不存在或已经失效");
  if (currentState.selectedLetter) throw new Error("本组选项已经选择完成");
  const state = cloneState(currentState);
  const forced = options.find((candidate) => candidate.status === "forced") ?? null;

  if (action === "uncover") {
    if (option.status !== "forced" || !forced) throw new Error("这个选项不能掀开");
    state.forcedUncovered = true;
    return { state, selected: null, notice: "已经掀开纸条" };
  }

  if (forced && !state.forcedUncovered && option.status !== "forced") {
    throw new Error("请先处理洛云希盖上的纸条");
  }

  if (action === "unlock") {
    if (option.status !== "deleted") throw new Error("这个选项不需要解锁");
    const clicks = Math.min(5, (state.deletedClicks[option.letter] ?? 0) + 1);
    state.deletedClicks[option.letter] = clicks;
    return {
      state,
      selected: null,
      notice: clicks >= 5 ? "已解锁，再点一次即可选择" : `解锁进度 ${clicks}/5`,
    };
  }

  if (action === "reveal") {
    if (option.status !== "hidden" && option.status !== "mystery") throw new Error("这个选项不能揭晓");
    if (!state.revealed.includes(option.letter)) state.revealed.push(option.letter);
    return { state, selected: null, notice: "选项已经揭晓" };
  }

  if (action !== "select") throw new Error("未知的选项操作");
  if (option.status === "deleted" && (state.deletedClicks[option.letter] ?? 0) < 5) {
    throw new Error("这个选项还需要继续解锁");
  }
  if ((option.status === "hidden" || option.status === "mystery") && !state.revealed.includes(option.letter)) {
    throw new Error("请先揭晓这个选项");
  }
  state.selectedLetter = option.letter;
  return { state, selected: option, notice: `已选择 ${option.letter}` };
}

export function formatXuanxiangSelection(option: XuanxiangOption): string {
  return `*(选择了：${option.letter} - ${option.selectionText})*`;
}

export function decodeXuanxiangCallback(data: string): {
  recordId: number;
  letter: string;
  action: XuanxiangAction;
} | null {
  const match = data.match(/^xq:(\d+):([A-F]):([sdru])$/);
  if (!match) return null;
  const recordId = Number(match[1]);
  if (!Number.isSafeInteger(recordId) || recordId <= 0) return null;
  const actionByToken: Record<string, XuanxiangAction> = {
    s: "select",
    d: "unlock",
    r: "reveal",
    u: "uncover",
  };
  return { recordId, letter: match[2], action: actionByToken[match[3]] };
}
