import type { CharacterCardDetails } from "../models/index";
import type { MvuTurnContext } from "./mvu-service";

const MAX_XUANXIANG_PROMPT_LENGTH = 30000;
const BLOCKED_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePath(root: unknown, path: string[]): unknown {
  let cursor = root;
  for (const part of path) {
    if (BLOCKED_PATH_PARTS.has(part) || !isRecord(cursor) || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function substituteText(input: string, characterName: string, userName: string): string {
  return input
    .replaceAll("{{char}}", characterName)
    .replaceAll("{{user}}", userName);
}

/** Builds the card-declared option rules only when its safely decoded state gate is active. */
export function createXuanxiangTurnPrompt(
  card: CharacterCardDetails,
  mvuContext: MvuTurnContext | null,
  userName: string,
): string | null {
  const config = card.xuanxiang;
  if (!config?.promptText.trim()) return null;

  if (config.activationPath) {
    const statData = mvuContext?.snapshot.stat_data;
    const value = resolvePath(statData, config.activationPath);
    if (typeof value !== "number" || config.activationMin === null || value < config.activationMin) {
      return null;
    }
  }

  const rules = substituteText(config.promptText, card.name, userName);
  return [
    "以下是当前角色卡明确声明的选项栏规则。仅在规则要求触发时输出一次完整的 <xuanxiang> 数据块；不要在思考过程里输出该标签。",
    rules,
  ].join("\n\n").slice(0, MAX_XUANXIANG_PROMPT_LENGTH);
}
