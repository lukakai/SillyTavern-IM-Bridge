import type {
  CharacterCardDetails,
  CharacterSummary,
  ChatMessage,
  ChatSearchResult,
  ModelSummary,
  MvuCardConfig,
  MvuRangeHint,
  StGenerationSettings,
  XuanxiangCardConfig,
} from "../../core/models/index";
import { timestampToMillis, normalizeChatFileName } from "./st-chat-mapper";
import { createStPayloadError } from "./st-errors";

export function decodeCharacterSummaries(payload: unknown): CharacterSummary[] {
  const items = Array.isArray(payload) ? payload : [];

  return items
    .map((item: any) => ({
      avatar: typeof item.avatar === "string" ? item.avatar : "",
      name: typeof item.name === "string" ? item.name : (typeof item.data?.name === "string" ? item.data.name : "Unknown"),
      dateLastChat: Number.isFinite(Number(item.date_last_chat)) ? Number(item.date_last_chat) : null,
      chatSize: Number.isFinite(Number(item.chat_size)) ? Number(item.chat_size) : null,
      dataSize: Number.isFinite(Number(item.data_size)) ? Number(item.data_size) : null,
    }))
    .filter((item) => item.avatar)
    .sort((left, right) => {
      const timeDiff = (right.dateLastChat ?? 0) - (left.dateLastChat ?? 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }

      return left.name.localeCompare(right.name, "zh-Hans-CN");
    });
}

function cardData(item: any): any {
  return item?.data && typeof item.data === "object" ? item.data : item;
}

function expandRangePath(rawPath: string): string[] {
  const placeholder = rawPath.match(/\$\{([^}]+)\}/);
  if (!placeholder) return [rawPath];
  return placeholder[1].split("|").map((choice) => rawPath.replace(placeholder[0], choice.trim()));
}

function pointerPath(parts: string[]): string {
  return `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function extractRangeHints(text: string): Record<string, MvuRangeHint> {
  const result: Record<string, MvuRangeHint> = {};
  const stack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const indent = (rawLine.match(/^[ \t]*/)?.[0] ?? "").replaceAll("\t", "  ").length;
    const line = rawLine.trim();
    if (!line || line.startsWith("-") || line.startsWith("#")) continue;
    const match = line.match(/^([^:]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = (match[2] ?? "").trim();

    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();

    if (key === "range") {
      const range = value.match(/(-?\d+(?:\.\d+)?)\s*(?:~|～|-|至)\s*(-?\d+(?:\.\d+)?)/);
      const fieldParts = stack.map((item) => item.key).filter((part) => part !== "变量更新规则");
      if (!range || fieldParts.length === 0) continue;
      const min = Number(range[1]);
      const max = Number(range[2]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) continue;

      const last = fieldParts.at(-1)!;
      const paths = last.includes(".") || last.includes("${")
        ? expandRangePath(last).map((path) => path.split(".").filter(Boolean))
        : [fieldParts];
      for (const pathParts of paths) result[pointerPath(pathParts)] = { min, max };
      continue;
    }

    if (!value) stack.push({ indent, key });
  }

  return result;
}

function decodeMvuCardConfig(item: any): MvuCardConfig | null {
  const data = cardData(item);
  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  const helperScripts = Array.isArray(data?.extensions?.tavern_helper?.scripts)
    ? data.extensions.tavern_helper.scripts
    : [];
  const hasMvuScript = helperScripts.some((script: any) => {
    const content = typeof script?.content === "string" ? script.content : "";
    return /MagVarUpdate|registerMvuSchema/i.test(content);
  });
  const initialEntry = entries.find((entry: any) => /\[initvar\]/i.test(String(entry?.comment ?? "")));
  const hasMvuProtocolEntry = entries.some((entry: any) => {
    const comment = String(entry?.comment ?? "");
    const content = typeof entry?.content === "string" ? entry.content : "";
    return /\[mvu_update\]/i.test(comment)
      || /\{\{format_message_variable::stat_data\}\}/i.test(content)
      || /<UpdateVariable\b/i.test(content);
  });
  const promptEntries = entries.filter((entry: any) => {
    if (entry?.enabled === false || typeof entry?.content !== "string") return false;
    const comment = String(entry?.comment ?? "");
    return /\[mvu_update\]/i.test(comment)
      || /^变量列表$/i.test(comment.trim())
      || /\{\{format_message_variable::stat_data\}\}/i.test(entry.content);
  });
  if (!hasMvuScript && !hasMvuProtocolEntry) return null;

  const updatePrompt = promptEntries.map((entry: any) => String(entry.content)).join("\n\n").trim();
  return {
    initialStateText: typeof initialEntry?.content === "string" ? initialEntry.content : null,
    updatePrompt,
    rangeHints: extractRangeHints(updatePrompt),
  };
}

const XUANXIANG_RULE_NAMES = [
  "选项栏总览",
  "选项栏输出规范",
  "异能对抗输出规范",
  "rule_互动回合与选项控制",
] as const;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolves the card's explicit xuanxiang rule bundle without evaluating EJS.
 * Disabled lorebook entries are only read when an enabled injector explicitly
 * references the xuanxiang output specification.
 */
function decodeXuanxiangCardConfig(item: any): XuanxiangCardConfig | null {
  const data = cardData(item);
  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  const specification = entries.find((entry: any) => {
    const comment = String(entry?.comment ?? "").trim();
    const content = typeof entry?.content === "string" ? entry.content : "";
    return comment === "选项栏输出规范" && /<xuanxiang>/i.test(content);
  });
  if (!specification) return null;

  const injectors = entries.filter((entry: any) => entry?.enabled !== false && typeof entry?.content === "string");
  const injector = injectors.find((entry: any) => /getwi\(\s*null\s*,\s*['"]选项栏输出规范['"]\s*\)/i.test(entry.content));
  if (specification.enabled === false && !injector) return null;

  const selectedEntries = XUANXIANG_RULE_NAMES
    .map((name) => entries.find((entry: any) => String(entry?.comment ?? "").trim() === name))
    .filter((entry: any) => typeof entry?.content === "string");
  const promptText = selectedEntries
    .map((entry: any) => String(entry.content).trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!promptText) return null;

  if (!injector) {
    return { promptText, activationPath: null, activationMin: null };
  }

  const injectorText = String(injector.content);
  const variableMatch = injectorText.match(
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*getvar\(\s*(['"])stat_data\.([^'"]+)\2/i,
  );
  if (!variableMatch) return null;

  const variableName = variableMatch[1];
  const thresholdMatch = injectorText.match(new RegExp(`${escapeRegExp(variableName)}\\s*>=\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!thresholdMatch) return null;
  const activationMin = Number(thresholdMatch[1]);
  const activationPath = variableMatch[3].split(".").map((part) => part.trim()).filter(Boolean);
  if (!Number.isFinite(activationMin) || activationPath.length === 0) return null;

  return { promptText, activationPath, activationMin };
}

export function decodeCharacterCard(payload: unknown, avatar: string): CharacterCardDetails {
  const items = Array.isArray(payload) ? payload : [];
  const item = items.find((entry: any) => entry?.avatar === avatar);

  if (!item) {
    throw createStPayloadError("CHARACTER_NOT_FOUND", `Character not found: ${avatar}`);
  }

  const data = cardData(item);
  return {
    avatar: String(item.avatar),
    name: typeof item.name === "string" ? item.name : (typeof data?.name === "string" ? data.name : ""),
    description: typeof item.description === "string" ? item.description : (typeof data?.description === "string" ? data.description : ""),
    personality: typeof item.personality === "string" ? item.personality : (typeof data?.personality === "string" ? data.personality : ""),
    scenario: typeof item.scenario === "string" ? item.scenario : (typeof data?.scenario === "string" ? data.scenario : ""),
    firstMes: typeof item.first_mes === "string" ? item.first_mes : (typeof data?.first_mes === "string" ? data.first_mes : ""),
    alternateGreetings: (Array.isArray(data?.alternate_greetings)
      ? data.alternate_greetings
      : Array.isArray(item.alternate_greetings) ? item.alternate_greetings : [])
      .filter((greeting: unknown): greeting is string => typeof greeting === "string"),
    mesExample: typeof item.mes_example === "string" ? item.mes_example : (typeof data?.mes_example === "string" ? data.mes_example : ""),
    mvu: decodeMvuCardConfig(item),
    xuanxiang: decodeXuanxiangCardConfig(item),
  };
}

export function decodeChatSearchResults(payload: unknown): ChatSearchResult[] {
  const items = Array.isArray(payload) ? payload : [];

  return items
    .map((item: any) => ({
      fileId: typeof item.file_name === "string" ? item.file_name : "",
      fileName: normalizeChatFileName(typeof item.file_name === "string" ? item.file_name : ""),
      fileSize: typeof item.file_size === "string" ? item.file_size : "Unknown",
      messageCount: Number.isFinite(Number(item.message_count)) ? Number(item.message_count) : 0,
      lastMessageAt: item.last_mes ?? null,
      previewMessage: typeof item.preview_message === "string" ? item.preview_message.trim() : "",
    }))
    .filter((item) => item.fileId)
    .sort((left, right) => timestampToMillis(right.lastMessageAt) - timestampToMillis(left.lastMessageAt));
}

export function decodeChatMessages(payload: unknown): ChatMessage[] {
  if (!Array.isArray(payload)) {
    throw createStPayloadError(
      "ST_CHAT_PAYLOAD_INVALID",
      `ST /api/chats/get returned non-array payload (${typeof payload}). Refusing to treat as empty chat.`,
    );
  }
  return payload as ChatMessage[];
}

export function decodeGenerationSettings(payload: any): StGenerationSettings {
  const settingsText = typeof payload?.settings === "string" ? payload.settings : "";
  if (!settingsText) {
    throw createStPayloadError("ST_SETTINGS_MISSING", "ST settings payload missing");
  }

  let settings: any;
  try {
    settings = JSON.parse(settingsText);
  } catch {
    throw createStPayloadError("ST_SETTINGS_INVALID", "ST settings payload is not valid JSON");
  }

  const oai = settings.oai_settings ?? {};
  const source = typeof oai.chat_completion_source === "string" ? oai.chat_completion_source : "custom";
  const customUrl = typeof oai.custom_url === "string" ? oai.custom_url : "";
  const customModel = typeof oai.custom_model === "string" && oai.custom_model.trim() ? oai.custom_model.trim() : "";
  const openaiModel = typeof oai.openai_model === "string" && oai.openai_model.trim() ? oai.openai_model.trim() : "";
  const model = customModel || openaiModel;

  if (!model) {
    throw createStPayloadError("ST_MODEL_MISSING", "ST current model is missing");
  }

  return {
    username: typeof settings.username === "string" && settings.username.trim() ? settings.username.trim() : "User",
    chatCompletionSource: source,
    model,
    customUrl,
    customPromptPostProcessing: typeof oai.custom_prompt_post_processing === "string" ? oai.custom_prompt_post_processing : "",
    temperature: Number.isFinite(Number(oai.temp_openai)) ? Number(oai.temp_openai) : 1,
    topP: Number.isFinite(Number(oai.top_p_openai)) ? Number(oai.top_p_openai) : 1,
    maxTokens: Number.isFinite(Number(oai.openai_max_tokens)) ? Number(oai.openai_max_tokens) : 1024,
  };
}

export function decodeModelSummaries(payload: any): ModelSummary[] {
  const data = Array.isArray(payload?.data) ? payload.data : [];

  return data
    .map((item: any) => ({
      id: typeof item?.id === "string" ? item.id : "",
      ownedBy: typeof item?.owned_by === "string" ? item.owned_by : null,
      description: typeof item?.description === "string" ? item.description : null,
    }))
    .filter((item: ModelSummary) => item.id);
}
