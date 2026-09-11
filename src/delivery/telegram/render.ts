import { InlineKeyboard } from "grammy";
import type { MessageEntity } from "grammy/types";
import type {
  ActiveSession,
  CharacterSummary,
  ChatSearchResult,
  LastTurnDetails,
  LatestDialogueRecord,
  ModelSummary,
  MvuRangeHint,
  MvuStatusSnapshot,
  RecentSession,
} from "../../core/models/index";
import { timestampToMillis } from "../../infra/st/st-chat-mapper";
import {
  createXuanxiangState,
  extractXuanxiang,
  renderXuanxiangPanel,
  type XuanxiangInteractionState,
  type XuanxiangOption,
  type XuanxiangPanel,
} from "./xuanxiang";

function formatDateTime(value: string | number | null): string {
  const timestamp = timestampToMillis(value);
  if (!timestamp) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(timestamp));
}

export function renderCharactersPage(
  characters: CharacterSummary[],
  page: number,
  pageSize: number,
  searchToken = "",
  searchLabel = "",
): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(characters.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const offset = safePage * pageSize;
  const pageItems = characters.slice(offset, offset + pageSize);
  const lines = [searchLabel ? `搜索结果：${searchLabel}` : "请选择角色：", ""];

  if (pageItems.length === 0) {
    lines.push("没有匹配的角色，请换个关键词。", "");
  }

  pageItems.forEach((item, index) => {
    const number = offset + index + 1;
    lines.push(`${number}. ${item.name}`);
    lines.push(`   avatar: ${item.avatar}`);
    lines.push(`   最近聊天: ${formatDateTime(item.dateLastChat)}`);
    lines.push("");
  });

  lines.push(`第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  for (let index = 0; index < pageItems.length; index += 1) {
    keyboard.text(
      String(offset + index + 1),
      searchToken ? `char:${searchToken}:${safePage}:${index}` : `char:${safePage}:${index}`,
    );
    if ((index + 1) % 4 === 0 || index === pageItems.length - 1) {
      keyboard.row();
    }
  }

  if (safePage > 0) {
    keyboard.text(
      "上一页",
      searchToken ? `characters:${searchToken}:${safePage - 1}` : `characters:${safePage - 1}`,
    );
  }
  if (safePage < totalPages - 1) {
    keyboard.text(
      "下一页",
      searchToken ? `characters:${searchToken}:${safePage + 1}` : `characters:${safePage + 1}`,
    );
  }

  return {
    text: lines.join("\n").trim(),
    keyboard,
  };
}

export function renderCharacterModeSelection(characterName: string): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
    .text("📚 查看历史会话", "char-mode:history")
    .text("✨ 直接开始新会话", "char-mode:new");
  return {
    text: `已选择角色：${characterName}\n\n请选择接下来的方式：`,
    keyboard,
  };
}

export function renderGreetingSelection(
  characterName: string,
  greetings: string[],
  index: number,
): { text: string; keyboard: InlineKeyboard } {
  const safeTotal = Math.max(1, greetings.length);
  const safeIndex = Math.min(Math.max(Math.floor(index), 0), safeTotal - 1);
  const keyboard = new InlineKeyboard();
  if (safeTotal > 1) {
    if (safeIndex > 0) keyboard.text("◀️", `greet:p:${safeIndex}`);
    keyboard.text(`${safeIndex + 1} / ${safeTotal}`, `greet:i:${safeIndex}`);
    if (safeIndex < safeTotal - 1) keyboard.text("▶️", `greet:n:${safeIndex}`);
    keyboard.row();
  }
  keyboard.text("✅ 使用这个开头", `greet:u:${safeIndex}`);
  return {
    text: `角色：${characterName}\n请选择开场白（${safeIndex + 1} / ${safeTotal}）：\n\n${greetings[safeIndex] ?? ""}`.trim(),
    keyboard,
  };
}

export function renderHistoryPage(characterName: string, chats: ChatSearchResult[], page: number, pageSize: number): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(chats.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const offset = safePage * pageSize;
  const pageItems = chats.slice(offset, offset + pageSize);
  const lines = [`角色：${characterName}`, "请选择历史会话（按最新修改时间排序）：", ""];

  pageItems.forEach((item, index) => {
    const number = offset + index + 1;
    lines.push(`${number}. ${item.fileName}`);
    lines.push(`   ${item.fileSize} | ${formatDateTime(item.lastMessageAt)}`);
    lines.push("");
  });

  lines.push(`第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  for (let index = 0; index < pageItems.length; index += 1) {
    keyboard.text(String(offset + index + 1), `open:${safePage}:${index}`);
    if ((index + 1) % 4 === 0 || index === pageItems.length - 1) {
      keyboard.row();
    }
  }

  if (safePage > 0) {
    keyboard.text("上一页", `history:${safePage - 1}`);
  }
  if (safePage < totalPages - 1) {
    keyboard.text("下一页", `history:${safePage + 1}`);
  }

  return {
    text: lines.join("\n").trim(),
    keyboard,
  };
}

export function renderRecentSessionsPage(recentSessions: RecentSession[]): { text: string; keyboard: InlineKeyboard } {
  const lines = ["最近会话：", ""];

  recentSessions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.characterName}`);
    lines.push(`   ${item.chatFile}.jsonl`);
    lines.push(`   ${formatDateTime(item.lastUsedAt)}`);
    lines.push("");
  });

  const keyboard = new InlineKeyboard();
  recentSessions.forEach((_, index) => {
    keyboard.text(String(index + 1), `recent:${index}`);
    if ((index + 1) % 4 === 0 || index === recentSessions.length - 1) {
      keyboard.row();
    }
  });

  return {
    text: lines.join("\n").trim(),
    keyboard,
  };
}

export function renderLatestDialogue(characterName: string, chatFile: string, record: LatestDialogueRecord | null): string {
  const lines = ["已切换到：", `${chatFile}.jsonl`, ""];

  if (!record) {
    lines.push("上一条记录：");
    lines.push("未找到可用的对话记录。");
    return lines.join("\n");
  }

  lines.push("上一条记录：");
  lines.push(`${record.speaker}：`);
  lines.push(record.text);
  lines.push("");
  lines.push(`当前角色：${characterName}`);
  return lines.join("\n");
}

export function renderCurrentState(state: ActiveSession | null, latestRecord: LatestDialogueRecord | null): string {
  if (!state || !state.activeCharacterAvatar || !state.activeCharacterName || !state.activeChatFile) {
    return "当前还没有绑定角色和会话。请先使用 /characters 或 /history。";
  }

  const base = renderLatestDialogue(state.activeCharacterName, state.activeChatFile, latestRecord);
  return `${base}\n当前模型：${state.activeModelOverride ?? "ST 默认"}`;
}

export function splitTelegramText(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
    if (splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    const chunk = remaining.slice(0, splitIndex).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export interface TelegramBranchChoice {
  label: string;
  text: string;
}

export interface TelegramResponseRender {
  text: string;
  entities: MessageEntity[];
  keyboard: InlineKeyboard | null;
  xuanxiang: (XuanxiangPanel & { options: XuanxiangOption[] }) | null;
}

export interface TelegramResponseRenderOptions {
  xuanxiangCallbackId?: string | null;
  xuanxiangState?: XuanxiangInteractionState;
}

export interface TelegramMessagePart {
  text: string;
  entities?: MessageEntity[];
}

interface ThoughtPlaceholderResult {
  text: string;
  thoughts: string[];
}

function extractThoughtPlaceholders(rawText: string): ThoughtPlaceholderResult {
  const thoughts: string[] = [];
  let text = rawText
    .replace(/\\(?=<!--|<\/?(?:content|branches|details|summary|think|thinking|xuanxiang)\b)/gi, "")
    .replace(/^\\(?=#{1,6}\s*(?:正文|content)\s*$)/gim, "");
  const stash = (content: string): string => {
    const cleaned = content.trim();
    if (!cleaned) return "";
    const index = thoughts.push(cleaned) - 1;
    return `\u0000ST_THINK_${index}\u0000`;
  };

  text = text.replace(
    /<!--\s*begin_of_(?:Subtext_)?think\s*-->([\s\S]*?)<!--\s*end_of_(?:Subtext_)?think\s*-->/gi,
    (_match, content: string) => stash(content),
  );
  text = text.replace(
    /<(think|thinking)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag: string, content: string) => stash(content),
  );

  return { text, thoughts };
}

function materializeThoughts(text: string, thoughts: string[]): { text: string; entities: MessageEntity[] } {
  const entities: MessageEntity[] = [];
  const tokenPattern = /\u0000ST_THINK_(\d+)\u0000/g;
  const label = "💭 思考过程（点击展开）\n";
  let output = "";
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const matchIndex = match.index ?? 0;
    const thought = thoughts[Number(match[1])] ?? "";
    output += text.slice(cursor, matchIndex);
    output += label;
    const offset = output.length;
    output += thought;
    if (thought) {
      entities.push({
        type: "expandable_blockquote",
        offset,
        length: thought.length,
      });
    }
    cursor = matchIndex + match[0].length;
  }

  output += text.slice(cursor);
  return { text: output.trim(), entities };
}

function parseBranchChoices(branchBody: string): TelegramBranchChoice[] {
  const plainBody = branchBody
    .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, "")
    .replace(/<\/?details\b[^>]*>/gi, "")
    .trim();
  const choices: TelegramBranchChoice[] = [];

  for (const rawLine of plainBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^([A-Z]|\d{1,2})[.)、:：]\s*(.+)$/i);
    if (match) {
      choices.push({
        label: match[1].toUpperCase(),
        text: match[2].trim(),
      });
      continue;
    }

    const current = choices.at(-1);
    if (current) {
      current.text = `${current.text}\n${line}`;
    }
  }

  return choices.slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pointerPath(parts: string[]): string {
  return `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function compactMvuValue(value: unknown, maxLength = 180): string {
  let text: string;
  if (typeof value === "boolean") {
    text = value ? "✅ 是" : "❌ 否";
  } else if (value === null) {
    text = "空";
  } else if (Array.isArray(value)) {
    text = value.every((item) => ["string", "number", "boolean"].includes(typeof item))
      ? value.join("、")
      : JSON.stringify(value);
  } else {
    text = String(value);
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function resolveRangeHint(
  path: string,
  label: string,
  value: number,
  hints: Record<string, MvuRangeHint>,
): MvuRangeHint | null {
  const explicit = hints[path];
  if (explicit) return explicit;
  if (/值$|进度$|百分比$|好感度$|怀疑度$/.test(label) && value >= 0 && value <= 100) {
    return { min: 0, max: 100 };
  }
  return null;
}

function renderMvuNumber(label: string, value: number, path: string, hints: Record<string, MvuRangeHint>): string {
  const range = resolveRangeHint(path, label, value, hints);
  if (!range) return `${label}：${value}`;
  const ratio = Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
  const filled = Math.round(ratio * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  return `${label}：${bar} ${value}/${range.max}`;
}

export function renderMvuStatus(status: MvuStatusSnapshot, maxLength = 2600): string {
  const lines: string[] = [];
  let usedLength = 0;
  let truncated = false;
  const append = (line: string): boolean => {
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (usedLength + cost > maxLength) {
      truncated = true;
      return false;
    }
    lines.push(line);
    usedLength += cost;
    return true;
  };

  const renderFields = (value: Record<string, unknown>, pathParts: string[], depth: number): void => {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("_")) continue;
      const nextPath = [...pathParts, key];
      if (isRecord(child)) {
        if (!append(`${"  ".repeat(depth)}▸ ${key}`)) return;
        renderFields(child, nextPath, depth + 1);
      } else if (typeof child === "number") {
        if (!append(`${"  ".repeat(depth)}${renderMvuNumber(key, child, pointerPath(nextPath), status.rangeHints)}`)) return;
      } else if (!append(`${"  ".repeat(depth)}${key}：${compactMvuValue(child)}`)) {
        return;
      }
    }
  };

  const rootEntries = Object.entries(status.statData).filter(([key]) => !key.startsWith("_"));
  const rootScalars = rootEntries.filter(([, value]) => !isRecord(value));
  const rootObjects = rootEntries.filter(([, value]) => isRecord(value));
  if (rootScalars.length > 0) {
    append("🌐 当前状态");
    renderFields(Object.fromEntries(rootScalars), [], 0);
  }
  for (const [key, value] of rootObjects) {
    if (!append(`${lines.length > 0 ? "\n" : ""}${/世界|时间|地点/.test(key) ? "🌍" : /选项|事件/.test(key) ? "🎯" : "👤"} ${key}`)) break;
    renderFields(value as Record<string, unknown>, [key], 0);
  }
  if (truncated) append("…状态内容过长，已省略其余字段");
  return lines.join("\n").trim();
}

function appendMvuStatus(
  text: string,
  entities: MessageEntity[],
  status: MvuStatusSnapshot | null,
): { text: string; entities: MessageEntity[] } {
  if (!status) return { text, entities };
  const body = renderMvuStatus(status);
  if (!body) return { text, entities };
  const label = "📊 MVU 状态（点击展开）\n";
  const prefix = text ? `${text}\n\n${label}` : label;
  return {
    text: `${prefix}${body}`,
    entities: [
      ...entities,
      {
        type: "expandable_blockquote",
        offset: prefix.length,
        length: body.length,
      },
    ],
  };
}

/** Converts SillyTavern branch markup into Telegram text and inline choice buttons. */
export function renderTelegramResponse(
  rawText: string,
  mvuStatus: MvuStatusSnapshot | null = null,
  options: TelegramResponseRenderOptions = {},
): TelegramResponseRender {
  const extracted = extractThoughtPlaceholders(rawText);
  let text = extracted.text
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:variable)?>/gi, "")
    .replace(/<UpdateVariable(?:variable)?\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<status_current_variables\b[^>]*>[\s\S]*?<\/status_current_variables>/gi, "")
    .replace(/<StatusPlaceHolderImpl\s*\/?>/gi, "")
    .replace(/<\/?content\b[^>]*>/gi, "")
    .replace(/<\/?(?:think|thinking)\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*#{1,6}\s*(?:正文|content)\s*$/gim, "")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
  const xuanxiangExtraction = extractXuanxiang(text);
  text = xuanxiangExtraction.text;
  const branchPattern = /<branches\b[^>]*>([\s\S]*?)<\/branches>/i;
  const match = branchPattern.exec(text);
  let keyboard: InlineKeyboard | null = null;

  if (match) {
    const choices = parseBranchChoices(match[1]);
    if (choices.length === 0) {
      text = text
      .replace(/<\/?branches\b[^>]*>/gi, "")
      .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, "")
      .replace(/<\/?details\b[^>]*>/gi, "")
      .trim();
    } else {
      const renderedChoices = [
        "请选择：",
        "",
        ...choices.map((choice) => `${choice.label}. ${choice.text}`),
      ].join("\n");
      text = `${text.slice(0, match.index)}${renderedChoices}${text.slice(match.index + match[0].length)}`.trim();
      keyboard = new InlineKeyboard();

      choices.forEach((choice, index) => {
        keyboard!.text(choice.label, `branch:${choice.label}`);
        if ((index + 1) % 5 === 0 || index === choices.length - 1) {
          keyboard!.row();
        }
      });
    }
  }

  const materialized = materializeThoughts(text, extracted.thoughts);
  const withMvu = appendMvuStatus(materialized.text, materialized.entities, mvuStatus);
  const xuanxiang = xuanxiangExtraction.options
    ? {
      ...renderXuanxiangPanel(
        xuanxiangExtraction.options,
        options.xuanxiangState ?? createXuanxiangState(),
        options.xuanxiangCallbackId ?? null,
      ),
      options: xuanxiangExtraction.options,
    }
    : null;
  return { text: withMvu.text, entities: withMvu.entities, keyboard, xuanxiang };
}

export function splitTelegramResponse(rendered: TelegramResponseRender, maxLength = 3500): TelegramMessagePart[] {
  const textParts = splitTelegramText(rendered.text, maxLength);
  let searchOffset = 0;

  return textParts.map((text) => {
    const sourceOffset = rendered.text.indexOf(text, searchOffset);
    const sourceEnd = sourceOffset + text.length;
    searchOffset = sourceEnd;

    const entities = rendered.entities.flatMap((entity): MessageEntity[] => {
      const entityStart = entity.offset;
      const entityEnd = entity.offset + entity.length;
      const clippedStart = Math.max(entityStart, sourceOffset);
      const clippedEnd = Math.min(entityEnd, sourceEnd);
      if (clippedStart >= clippedEnd) return [];
      return [{
        ...entity,
        offset: clippedStart - sourceOffset,
        length: clippedEnd - clippedStart,
      }];
    });

    return {
      text,
      ...(entities.length > 0 ? { entities } : {}),
    };
  });
}

export function renderHelp(): string {
  return [
    "可用命令：",
    "/start - 开始使用",
    "/chars - 选择角色",
    "/hist - 查看历史会话",
    "/new - 基于当前角色新建会话",
    "/now - 查看当前会话",
    "/last - 查看最后一轮",
    "/redo - 重新生成当前回复",
    "/undo - 删除最后一轮",
    "/revoke - 撤回上一轮（TG + ST）",
    "/recent - 查看最近使用的会话",
    "/model - 查看并切换当前可用模型",
    "/cmodel - 查看并切换压缩专用模型",
    "/compress - 压缩当前会话历史（保留最近 15 条）",
    "/help - 查看帮助",
    "",
    "/chars [关键词] - 按角色名或头像搜索角色卡",
    "选中角色后可查看历史会话，或直接选择开场白开始新会话。",
    "角色回复下方可按需重新生成、添加备选，并用左右按钮切换。",
    "编辑最新一条 Telegram 用户消息会同步到 ST，但不会自动生成；随后再点回复下方按钮。",
    "",
    "兼容长命令：/characters /history /current。",
  ].join("\n");
}

export function renderLastTurn(details: LastTurnDetails): string {
  const lines = ["最后一轮：", ""];

  if (!details.userMessage && !details.assistantMessage) {
    lines.push("当前会话还没有可查看的尾部对话。");
    return lines.join("\n");
  }

  if (details.userMessage) {
    lines.push(`用户 ${details.userMessage.speaker}：`);
    lines.push(details.userMessage.text);
    lines.push("");
  }

  if (details.assistantMessage) {
    lines.push(`角色 ${details.assistantMessage.speaker}：`);
    lines.push(details.assistantMessage.text);
  } else {
    lines.push("当前尾部还没有角色回复。");
  }

  return lines.join("\n").trim();
}

export function renderUndoResult(details: LastTurnDetails): string {
  const lines = ["已删除最后一轮：", ""];

  if (details.userMessage) {
    lines.push(`用户 ${details.userMessage.speaker}：`);
    lines.push(details.userMessage.text);
    lines.push("");
  }

  if (details.assistantMessage) {
    lines.push(`角色 ${details.assistantMessage.speaker}：`);
    lines.push(details.assistantMessage.text);
  }

  return lines.join("\n").trim();
}

export interface ProviderGroup {
  provider: string;
  models: ModelSummary[];
}

export function groupModelsByProvider(models: ModelSummary[]): ProviderGroup[] {
  const buckets = new Map<string, ModelSummary[]>();
  for (const model of models) {
    const key = (model.ownedBy ?? "").trim() || "未知";
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(model);
    } else {
      buckets.set(key, [model]);
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === "未知" && right !== "未知") return 1;
      if (right === "未知" && left !== "未知") return -1;
      return left.localeCompare(right, "en");
    })
    .map(([provider, items]) => ({ provider, models: items }));
}

export interface ModelCallbackPrefix {
  providers: string;
  provider: string;
  pmodels: string;
  pmodel: string;
  reset: string;
}

export const DEFAULT_MODEL_CALLBACK_PREFIX: ModelCallbackPrefix = {
  providers: "providers",
  provider: "provider",
  pmodels: "pmodels",
  pmodel: "pmodel",
  reset: "model:reset",
};

export const COMPRESSION_MODEL_CALLBACK_PREFIX: ModelCallbackPrefix = {
  providers: "cproviders",
  provider: "cprovider",
  pmodels: "cpmodels",
  pmodel: "cpmodel",
  reset: "cmodel:reset",
};

export function renderProviderPage(
  groups: ProviderGroup[],
  currentModel: string,
  page: number,
  pageSize: number,
  callbackPrefix: ModelCallbackPrefix = DEFAULT_MODEL_CALLBACK_PREFIX,
): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const offset = safePage * pageSize;
  const pageItems = groups.slice(offset, offset + pageSize);

  const currentProvider = groups.find((group) => group.models.some((model) => model.id === currentModel))?.provider ?? null;

  const lines = [`当前模型：${currentModel}`, "请选择模型供应商：", ""];
  pageItems.forEach((group, index) => {
    const number = offset + index + 1;
    const marker = group.provider === currentProvider ? " [当前]" : "";
    lines.push(`${number}. ${group.provider} (${group.models.length} 个)${marker}`);
  });
  lines.push("");
  lines.push(`第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  for (let index = 0; index < pageItems.length; index += 1) {
    const globalIdx = offset + index;
    keyboard.text(String(offset + index + 1), `${callbackPrefix.provider}:${globalIdx}`);
    if ((index + 1) % 4 === 0 || index === pageItems.length - 1) {
      keyboard.row();
    }
  }

  keyboard.text("使用 ST 默认", callbackPrefix.reset).row();

  if (safePage > 0) {
    keyboard.text("上一页", `${callbackPrefix.providers}:${safePage - 1}`);
  }
  if (safePage < totalPages - 1) {
    keyboard.text("下一页", `${callbackPrefix.providers}:${safePage + 1}`);
  }

  return {
    text: lines.join("\n").trim(),
    keyboard,
  };
}

export function renderProviderModelPage(
  group: ProviderGroup,
  providerIdx: number,
  currentModel: string,
  page: number,
  pageSize: number,
  callbackPrefix: ModelCallbackPrefix = DEFAULT_MODEL_CALLBACK_PREFIX,
): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(group.models.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const offset = safePage * pageSize;
  const pageItems = group.models.slice(offset, offset + pageSize);

  const lines = [
    `供应商：${group.provider}`,
    `当前模型：${currentModel}`,
    "请选择要切换的模型：",
    "",
  ];

  pageItems.forEach((item, index) => {
    const number = offset + index + 1;
    const marker = item.id === currentModel ? " [当前]" : "";
    lines.push(`${number}. ${item.id}${marker}`);
  });
  lines.push("");
  lines.push(`第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  for (let index = 0; index < pageItems.length; index += 1) {
    keyboard.text(String(offset + index + 1), `${callbackPrefix.pmodel}:${providerIdx}:${safePage}:${index}`);
    if ((index + 1) % 4 === 0 || index === pageItems.length - 1) {
      keyboard.row();
    }
  }

  keyboard.text("返回供应商", `${callbackPrefix.providers}:0`);
  if (safePage > 0) {
    keyboard.text("上一页", `${callbackPrefix.pmodels}:${providerIdx}:${safePage - 1}`);
  }
  if (safePage < totalPages - 1) {
    keyboard.text("下一页", `${callbackPrefix.pmodels}:${providerIdx}:${safePage + 1}`);
  }

  return {
    text: lines.join("\n").trim(),
    keyboard,
  };
}

export function renderModelPage(models: ModelSummary[], currentModel: string, page: number, pageSize: number): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const offset = safePage * pageSize;
  const pageItems = models.slice(offset, offset + pageSize);
  const lines = [`当前模型：${currentModel}`, "请选择要切换的模型：", ""];

  pageItems.forEach((item, index) => {
    const number = offset + index + 1;
    const marker = item.id === currentModel ? " [当前]" : "";
    lines.push(`${number}. ${item.id}${marker}`);
    if (item.ownedBy) {
      lines.push(`   provider: ${item.ownedBy}`);
    }
    lines.push("");
  });

  lines.push(`第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  for (let index = 0; index < pageItems.length; index += 1) {
    keyboard.text(String(offset + index + 1), `model:${safePage}:${index}`);
    if ((index + 1) % 4 === 0 || index === pageItems.length - 1) {
      keyboard.row();
    }
  }

  keyboard.text("使用 ST 默认", "model:reset").row();

  if (safePage > 0) {
    keyboard.text("上一页", `models:${safePage - 1}`);
  }
  if (safePage < totalPages - 1) {
    keyboard.text("下一页", `models:${safePage + 1}`);
  }

  return {
    text: lines.join("\n").trim(),
    keyboard,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function renderCompressProgress(completed: number, total: number): string {
  if (total <= 0) {
    return "压缩中… 没有需要压缩的消息。";
  }
  const percent = Math.floor((completed / total) * 100);
  return `正在压缩当前会话…\n进度：${completed} / ${total}（${percent}%）`;
}

export function renderCompressResult(params: {
  compressedCount: number;
  skippedCount: number;
  originalBytes: number;
  compressedBytes: number;
  backupFile: string;
}): string {
  const total = params.compressedCount + params.skippedCount;
  if (total === 0 && params.backupFile === "") {
    return "压缩完成：当前会话没有需要压缩的旧消息（已保留最近若干条）。";
  }

  const saved = Math.max(0, params.originalBytes - params.compressedBytes);
  const ratio = params.originalBytes > 0 ? Math.floor((saved / params.originalBytes) * 100) : 0;

  const lines = [
    "压缩完成。",
    `成功：${params.compressedCount} 条`,
    `跳过：${params.skippedCount} 条（结果不短于原文或调用失败）`,
    `文件大小：${formatBytes(params.originalBytes)} → ${formatBytes(params.compressedBytes)}（节省 ${ratio}%）`,
  ];
  if (params.backupFile) {
    lines.push(`备份文件：${params.backupFile}`);
  }
  return lines.join("\n");
}
