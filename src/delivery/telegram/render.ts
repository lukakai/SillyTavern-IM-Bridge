import { InlineKeyboard } from "grammy";
import type {
  ActiveSession,
  CharacterSummary,
  ChatSearchResult,
  LastTurnDetails,
  LatestDialogueRecord,
  ModelSummary,
  RecentSession,
} from "../../core/models/index";
import { timestampToMillis } from "../../infra/st/st-chat-mapper";

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

export function renderCharactersPage(characters: CharacterSummary[], page: number, pageSize: number): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.max(1, Math.ceil(characters.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const offset = safePage * pageSize;
  const pageItems = characters.slice(offset, offset + pageSize);
  const lines = ["请选择角色：", ""];

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
    keyboard.text(String(offset + index + 1), `char:${safePage}:${index}`);
    if ((index + 1) % 4 === 0 || index === pageItems.length - 1) {
      keyboard.row();
    }
  }

  if (safePage > 0) {
    keyboard.text("上一页", `characters:${safePage - 1}`);
  }
  if (safePage < totalPages - 1) {
    keyboard.text("下一页", `characters:${safePage + 1}`);
  }

  return {
    text: lines.join("\n").trim(),
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
  keyboard: InlineKeyboard | null;
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

/** Converts SillyTavern branch markup into Telegram text and inline choice buttons. */
export function renderTelegramResponse(rawText: string): TelegramResponseRender {
  const text = rawText.replace(/<\/?content\b[^>]*>/gi, "").trim();
  const branchPattern = /<branches\b[^>]*>([\s\S]*?)<\/branches>/i;
  const match = branchPattern.exec(text);

  if (!match) {
    return { text, keyboard: null };
  }

  const choices = parseBranchChoices(match[1]);
  if (choices.length === 0) {
    const cleaned = text
      .replace(/<\/?branches\b[^>]*>/gi, "")
      .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, "")
      .replace(/<\/?details\b[^>]*>/gi, "")
      .trim();
    return { text: cleaned, keyboard: null };
  }

  const renderedChoices = [
    "请选择：",
    "",
    ...choices.map((choice) => `${choice.label}. ${choice.text}`),
  ].join("\n");
  const renderedText = `${text.slice(0, match.index)}${renderedChoices}${text.slice(match.index + match[0].length)}`.trim();
  const keyboard = new InlineKeyboard();

  choices.forEach((choice, index) => {
    keyboard.text(choice.label, `branch:${choice.label}`);
    if ((index + 1) % 5 === 0 || index === choices.length - 1) {
      keyboard.row();
    }
  });

  return { text: renderedText, keyboard };
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
    "/redo - 重生成回复",
    "/undo - 删除最后一轮",
    "/revoke - 撤回上一轮（TG + ST）",
    "/recent - 查看最近使用的会话",
    "/model - 查看并切换当前可用模型",
    "/cmodel - 查看并切换压缩专用模型",
    "/compress - 压缩当前会话历史（保留最近 15 条）",
    "/help - 查看帮助",
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
