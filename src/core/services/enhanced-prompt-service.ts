import type { CharacterCardDetails, ChatMessage, StGenerationSettings } from "../models/index";
import { activateWorldBook, renderWorldBookEntries } from "./world-book-service";

const MAX_ENHANCED_SYSTEM_CHARS = 72_000;

function substitute(input: string, characterName: string, userName: string): string {
  return input
    .replaceAll("{{char}}", characterName)
    .replaceAll("{{user}}", userName)
    .trim();
}

function appendWithinBudget(parts: string[], value: string, remaining: { value: number }): void {
  const text = value.trim();
  if (!text || remaining.value <= 0) return;
  const clipped = text.slice(0, remaining.value);
  parts.push(clipped);
  remaining.value -= clipped.length;
}

/** Builds a stable, headless prompt that closely follows text-based ST cards. */
export function buildEnhancedSystemPrompt(params: {
  card: CharacterCardDetails;
  settings: StGenerationSettings;
  chat: ChatMessage[];
  pendingUserText?: string;
  mvuStatData?: Record<string, unknown> | null;
}): string {
  const { card, settings, chat } = params;
  const characterName = card.name;
  const userName = settings.username;
  const worldBook = activateWorldBook(card.worldBookEntries ?? [], chat, {
    characterName,
    userName,
    pendingUserText: params.pendingUserText,
    personaDescription: settings.personaDescription,
    characterDescription: card.description,
    characterPersonality: card.personality,
    scenario: card.scenario,
    creatorNotes: card.creatorNotes,
    characterDepthPrompt: card.depthPrompt?.prompt,
    statData: params.mvuStatData,
  });
  const beforeWorldBook = renderWorldBookEntries(worldBook.beforeCharacter, characterName, userName);
  const afterWorldBook = renderWorldBookEntries(worldBook.afterCharacter, characterName, userName);
  const remaining = { value: MAX_ENHANCED_SYSTEM_CHARS };
  const parts: string[] = [];

  appendWithinBudget(parts, `你正在扮演 ${characterName}。严格保持角色设定并继续当前剧情，不要跳出角色。`, remaining);
  appendWithinBudget(parts, substitute(card.systemPrompt ?? "", characterName, userName), remaining);
  appendWithinBudget(parts, substitute(settings.personaDescription ?? "", characterName, userName), remaining);
  appendWithinBudget(parts, beforeWorldBook, remaining);
  appendWithinBudget(parts, substitute(card.description, characterName, userName), remaining);
  appendWithinBudget(parts, substitute(card.personality, characterName, userName), remaining);
  appendWithinBudget(parts, substitute(card.scenario, characterName, userName), remaining);
  if (card.mesExample) {
    appendWithinBudget(parts, `示例对话：\n${substitute(card.mesExample, characterName, userName)}`, remaining);
  }
  appendWithinBudget(parts, afterWorldBook, remaining);
  if (card.depthPrompt?.prompt) {
    appendWithinBudget(parts, substitute(card.depthPrompt.prompt, characterName, userName), remaining);
  }
  appendWithinBudget(parts, substitute(card.postHistoryInstructions ?? "", characterName, userName), remaining);

  if (worldBook.skippedDynamic > 0) {
    console.warn(JSON.stringify({
      scope: "world_book",
      event: "dynamic_entries_skipped",
      character: characterName,
      count: worldBook.skippedDynamic,
    }));
  }
  if (worldBook.truncated || remaining.value === 0) {
    console.warn(JSON.stringify({
      scope: "world_book",
      event: "prompt_budget_reached",
      character: characterName,
    }));
  }
  return parts.join("\n\n");
}
