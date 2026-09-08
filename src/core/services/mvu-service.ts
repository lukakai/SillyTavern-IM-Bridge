import type {
  CharacterCardDetails,
  ChatMessage,
  MvuRangeHint,
  MvuStatusSnapshot,
} from "../models/index";

type JsonRecord = Record<string, unknown>;

export interface MvuTurnContext {
  snapshot: JsonRecord;
  prompt: string | null;
  rangeHints: Record<string, MvuRangeHint>;
}

export interface MvuReplyResult {
  snapshot: JsonRecord;
  status: MvuStatusSnapshot;
  appliedOperations: number;
  error: string | null;
}

interface ParsedPatchBlock {
  found: boolean;
  operations: unknown[] | null;
  error: string | null;
}

const MAX_PATCH_OPERATIONS = 200;
const MAX_POINTER_DEPTH = 32;
const MAX_MVU_PROMPT_LENGTH = 30000;
const BLOCKED_POINTER_PARTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function substituteText(input: string, characterName: string, userName: string): string {
  return input
    .replaceAll("{{char}}", characterName)
    .replaceAll("{{user}}", userName);
}

function substituteObject(value: unknown, characterName: string, userName: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => substituteObject(item, characterName, userName));
  }

  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      substituteText(key, characterName, userName),
      substituteObject(child, characterName, userName),
    ]));
  }

  return typeof value === "string" ? substituteText(value, characterName, userName) : value;
}

function parseYamlScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }

  return value;
}

/** Parses the mapping-only YAML used by common [initvar] lorebook entries. */
export function parseMvuInitialState(input: string): JsonRecord | null {
  const root: JsonRecord = {};
  const stack: Array<{ indent: number; value: JsonRecord }> = [{ indent: -1, value: root }];

  for (const rawLine of input.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim() === "---" || rawLine.trim().startsWith("#")) {
      continue;
    }

    if (rawLine.trimStart().startsWith("-")) {
      return null;
    }

    const indentText = rawLine.match(/^[ \t]*/)?.[0] ?? "";
    const indent = indentText.replaceAll("\t", "  ").length;
    const content = rawLine.trim();
    const separator = content.indexOf(":");
    if (separator <= 0) {
      return null;
    }

    const key = content.slice(0, separator).trim();
    const rawValue = content.slice(separator + 1).trim();
    if (!key) {
      return null;
    }

    while (stack.length > 1 && stack.at(-1)!.indent >= indent) {
      stack.pop();
    }

    const parent = stack.at(-1)!.value;
    if (!rawValue) {
      const child: JsonRecord = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }

  return Object.keys(root).length > 0 ? root : null;
}

function selectMessageVariableSnapshot(message: ChatMessage): JsonRecord | null {
  const variables = message.variables;
  if (isRecord(variables)) {
    return isRecord(variables.stat_data) ? cloneValue(variables) : null;
  }

  if (!Array.isArray(variables)) {
    return null;
  }

  const swipeId = Number(message.swipe_id);
  if (Number.isInteger(swipeId) && swipeId >= 0) {
    const selected = variables[swipeId];
    return isRecord(selected) && isRecord(selected.stat_data) ? cloneValue(selected) : null;
  }

  for (let index = variables.length - 1; index >= 0; index -= 1) {
    const candidate = variables[index];
    if (isRecord(candidate) && isRecord(candidate.stat_data)) {
      return cloneValue(candidate);
    }
  }

  return null;
}

export function findLatestMvuSnapshot(messages: ChatMessage[]): JsonRecord | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const snapshot = selectMessageVariableSnapshot(messages[index]);
    if (snapshot) return snapshot;
  }
  return null;
}

function buildInitialSnapshot(card: CharacterCardDetails, userName: string): JsonRecord | null {
  const initialText = card.mvu?.initialStateText;
  if (!initialText) return null;
  const parsed = parseMvuInitialState(initialText);
  if (!parsed) return null;

  return {
    display_data: {},
    initialized_lorebooks: {},
    stat_data: substituteObject(parsed, card.name, userName),
    delta_data: {},
    schema: {},
  };
}

function substituteRangeHints(
  hints: Record<string, MvuRangeHint>,
  characterName: string,
  userName: string,
): Record<string, MvuRangeHint> {
  return Object.fromEntries(Object.entries(hints).map(([path, range]) => [
    substituteText(path, characterName, userName),
    { ...range },
  ]));
}

function buildMvuPrompt(card: CharacterCardDetails, userName: string, statData: JsonRecord): string | null {
  if (!card.mvu?.updatePrompt.trim()) return null;
  const stateText = JSON.stringify(statData, null, 2);
  const rawRules = substituteText(card.mvu.updatePrompt, card.name, userName);
  const hasStateMacro = /\{\{format_message_variable::stat_data\}\}/i.test(rawRules);
  const rules = rawRules
    .replace(/\{\{format_message_variable::stat_data\}\}/gi, stateText);
  const prompt = [
    "以下是当前会话的 MVU 状态和更新协议。回复正文后必须按协议输出结构化变量更新；不要省略要求的 UpdateVariable 标记。",
    hasStateMacro ? "" : `<status_current_variables>\n${stateText}\n</status_current_variables>`,
    rules,
  ].filter(Boolean).join("\n\n");
  return prompt.slice(0, MAX_MVU_PROMPT_LENGTH);
}

export function createMvuTurnContext(
  card: CharacterCardDetails,
  messages: ChatMessage[],
  userName: string,
): MvuTurnContext | null {
  const snapshot = findLatestMvuSnapshot(messages) ?? buildInitialSnapshot(card, userName);
  if (!snapshot || !isRecord(snapshot.stat_data)) return null;

  const rangeHints = substituteRangeHints(card.mvu?.rangeHints ?? {}, card.name, userName);
  return {
    snapshot,
    prompt: buildMvuPrompt(card, userName, snapshot.stat_data),
    rangeHints,
  };
}

function parsePatchBlock(rawText: string): ParsedPatchBlock {
  const blocks = [...rawText.matchAll(/<JSONPatch\b[^>]*>\s*([\s\S]*?)\s*<\/JSONPatch>/gi)];
  if (blocks.length === 0) {
    return { found: false, operations: null, error: null };
  }

  const body = blocks.at(-1)?.[1]
    ?.replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim() ?? "";
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      return { found: true, operations: null, error: "JSONPatch 必须是数组" };
    }
    if (parsed.length > MAX_PATCH_OPERATIONS) {
      return { found: true, operations: null, error: `JSONPatch 操作数超过 ${MAX_PATCH_OPERATIONS}` };
    }
    return { found: true, operations: parsed, error: null };
  } catch (error) {
    return {
      found: true,
      operations: null,
      error: `JSONPatch 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function decodePointer(path: unknown): string[] {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("MVU 路径必须以 / 开头");
  }
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length === 0 || parts.length > MAX_POINTER_DEPTH || parts.some((part) => !part || BLOCKED_POINTER_PARTS.has(part))) {
    throw new Error("MVU 路径无效或不安全");
  }
  return parts;
}

function resolveParent(root: unknown, parts: string[]): { parent: JsonRecord | unknown[]; key: string } {
  let cursor: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) throw new Error(`数组路径不存在：${part}`);
      cursor = cursor[index];
    } else if (isRecord(cursor) && Object.hasOwn(cursor, part)) {
      cursor = cursor[part];
    } else {
      throw new Error(`对象路径不存在：${part}`);
    }
  }

  if (!Array.isArray(cursor) && !isRecord(cursor)) throw new Error("MVU 路径的父节点不是容器");
  return { parent: cursor, key: parts.at(-1)! };
}

function arrayIndex(key: string, length: number, allowEnd = false): number {
  if (allowEnd && key === "-") return length;
  const index = Number(key);
  const max = allowEnd ? length : length - 1;
  if (!Number.isInteger(index) || index < 0 || index > max) throw new Error(`数组索引无效：${key}`);
  return index;
}

function getValue(root: unknown, parts: string[]): unknown {
  let cursor = root;
  for (const part of parts) {
    if (Array.isArray(cursor)) {
      cursor = cursor[arrayIndex(part, cursor.length)];
    } else if (isRecord(cursor) && Object.hasOwn(cursor, part)) {
      cursor = cursor[part];
    } else {
      throw new Error(`MVU 路径不存在：/${parts.join("/")}`);
    }
  }
  return cursor;
}

function removeValue(root: unknown, parts: string[]): unknown {
  const { parent, key } = resolveParent(root, parts);
  if (Array.isArray(parent)) {
    return parent.splice(arrayIndex(key, parent.length), 1)[0];
  }
  if (!Object.hasOwn(parent, key)) throw new Error(`MVU 路径不存在：/${parts.join("/")}`);
  const value = parent[key];
  delete parent[key];
  return value;
}

function insertValue(root: unknown, parts: string[], value: unknown): void {
  const { parent, key } = resolveParent(root, parts);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(key, parent.length, true), 0, cloneValue(value));
  } else {
    parent[key] = cloneValue(value);
  }
}

export function applyMvuOperations(statData: JsonRecord, operations: unknown[]): JsonRecord {
  const next = cloneValue(statData);

  for (const rawOperation of operations) {
    if (!isRecord(rawOperation) || typeof rawOperation.op !== "string") {
      throw new Error("MVU 操作格式无效");
    }

    const op = rawOperation.op.toLowerCase();
    if (op === "move") {
      const from = decodePointer(rawOperation.from);
      const to = decodePointer(rawOperation.to ?? rawOperation.path);
      getValue(next, from);
      const moved = removeValue(next, from);
      insertValue(next, to, moved);
      continue;
    }

    const parts = decodePointer(rawOperation.path);
    const { parent, key } = resolveParent(next, parts);
    if (op === "insert") {
      insertValue(next, parts, rawOperation.value);
      continue;
    }
    if (op === "remove") {
      removeValue(next, parts);
      continue;
    }

    if (Array.isArray(parent)) {
      const index = arrayIndex(key, parent.length);
      if (op === "replace") {
        parent[index] = cloneValue(rawOperation.value);
      } else if (op === "delta") {
        if (typeof parent[index] !== "number" || typeof rawOperation.value !== "number") throw new Error("delta 只能用于数字");
        parent[index] = (parent[index] as number) + rawOperation.value;
      } else {
        throw new Error(`不支持的 MVU 操作：${op}`);
      }
      continue;
    }

    if (!Object.hasOwn(parent, key)) throw new Error(`MVU 路径不存在：/${parts.join("/")}`);
    if (op === "replace") {
      parent[key] = cloneValue(rawOperation.value);
    } else if (op === "delta") {
      if (typeof parent[key] !== "number" || typeof rawOperation.value !== "number") throw new Error("delta 只能用于数字");
      parent[key] = (parent[key] as number) + rawOperation.value;
    } else {
      throw new Error(`不支持的 MVU 操作：${op}`);
    }
  }

  return next;
}

function clampMvuRanges(statData: JsonRecord, hints: Record<string, MvuRangeHint>): void {
  for (const [path, range] of Object.entries(hints)) {
    try {
      const parts = decodePointer(path);
      const { parent, key } = resolveParent(statData, parts);
      if (Array.isArray(parent)) {
        const index = arrayIndex(key, parent.length);
        if (typeof parent[index] === "number") parent[index] = Math.min(range.max, Math.max(range.min, parent[index] as number));
      } else if (typeof parent[key] === "number") {
        parent[key] = Math.min(range.max, Math.max(range.min, parent[key] as number));
      }
    } catch {
      // Range hints are optional display metadata; stale paths must not reject a valid patch.
    }
  }
}

export function processMvuReply(rawText: string, context: MvuTurnContext | null): MvuReplyResult | null {
  if (!context || !isRecord(context.snapshot.stat_data)) return null;
  const snapshot = cloneValue(context.snapshot);
  const parsed = parsePatchBlock(rawText);
  let appliedOperations = 0;
  let error = parsed.error;

  if (parsed.operations) {
    try {
      snapshot.stat_data = applyMvuOperations(snapshot.stat_data as JsonRecord, parsed.operations);
      clampMvuRanges(snapshot.stat_data as JsonRecord, context.rangeHints);
      snapshot.display_data = {};
      snapshot.delta_data = {};
      appliedOperations = parsed.operations.length;
    } catch (patchError) {
      error = patchError instanceof Error ? patchError.message : String(patchError);
    }
  }

  return {
    snapshot,
    status: {
      statData: cloneValue(snapshot.stat_data as JsonRecord),
      rangeHints: cloneValue(context.rangeHints),
    },
    appliedOperations,
    error,
  };
}

export function attachMvuSnapshot(message: ChatMessage, snapshot: JsonRecord | null): ChatMessage {
  if (!snapshot) return message;
  return {
    ...message,
    swipe_id: 0,
    swipes: [message.mes ?? ""],
    variables: [cloneValue(snapshot)],
    variables_initialized: [true],
  };
}
