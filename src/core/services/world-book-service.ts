import type { ChatMessage, WorldBookEntry } from "../models/index";

const DEFAULT_SCAN_DEPTH = 24;
const DEFAULT_MAX_CHARS = 48_000;
const MAX_RECURSION_PASSES = 3;

export interface ActivatedWorldBook {
  beforeCharacter: WorldBookEntry[];
  afterCharacter: WorldBookEntry[];
  skippedDynamic: number;
  truncated: boolean;
}

interface SelectionOptions {
  characterName: string;
  userName: string;
  pendingUserText?: string;
  maxChars?: number;
  random?: () => number;
  personaDescription?: string;
  characterDescription?: string;
  characterPersonality?: string;
  scenario?: string;
  creatorNotes?: string;
  characterDepthPrompt?: string;
  statData?: Record<string, unknown> | null;
}

function substitute(input: string, characterName: string, userName: string): string {
  return input
    .replaceAll("{{char}}", characterName)
    .replaceAll("{{user}}", userName);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKey(source: string, rawKey: string, entry: WorldBookEntry, options: SelectionOptions): boolean {
  const key = substitute(rawKey, options.characterName, options.userName).trim();
  if (!key) return false;
  if (entry.matchWholeWords) {
    const flags = entry.caseSensitive ? "u" : "iu";
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(key)}(?![\\p{L}\\p{N}_])`, flags).test(source);
  }
  return entry.caseSensitive
    ? source.includes(key)
    : source.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

function messageCorpus(messages: ChatMessage[], pendingUserText: string, depth: number): string {
  const parts = messages
    .filter((message) => !message.is_system && typeof message.mes === "string" && message.mes.trim())
    .map((message) => String(message.mes));
  if (pendingUserText.trim()) parts.push(pendingUserText.trim());
  return parts.slice(-Math.max(1, depth)).join("\n");
}

function extendedCorpus(entry: WorldBookEntry, base: string, options: SelectionOptions): string {
  const additions = [
    entry.matchPersonaDescription ? options.personaDescription : "",
    entry.matchCharacterDescription ? options.characterDescription : "",
    entry.matchCharacterPersonality ? options.characterPersonality : "",
    entry.matchScenario ? options.scenario : "",
    entry.matchCreatorNotes ? options.creatorNotes : "",
    entry.matchCharacterDepthPrompt ? options.characterDepthPrompt : "",
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return additions.length > 0 ? `${base}\n${additions.join("\n")}` : base;
}

function matchesEntry(entry: WorldBookEntry, corpus: string, options: SelectionOptions): boolean {
  if (entry.constant) return true;
  if (entry.keys.length === 0) return false;
  const primary = entry.keys.some((key) => containsKey(corpus, key, entry, options));
  if (!primary) return false;
  if (!entry.selective || entry.secondaryKeys.length === 0) return true;

  const secondaryMatches = entry.secondaryKeys.map((key) => containsKey(corpus, key, entry, options));
  switch (entry.selectiveLogic) {
    case 1:
      return secondaryMatches.every(Boolean);
    case 2:
      return !secondaryMatches.some(Boolean);
    case 3:
      return !secondaryMatches.every(Boolean);
    case 0:
    default:
      return secondaryMatches.some(Boolean);
  }
}

function isDynamicEntry(entry: WorldBookEntry): boolean {
  return /<%[\s\S]*?%>/.test(entry.content);
}

function readStatePath(statData: Record<string, unknown>, path: string): unknown {
  let current: unknown = statData;
  for (const part of path.split(".").map((value) => value.trim()).filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseComparisonValue(raw: string): unknown {
  const value = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const quoted = value.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : undefined;
}

function compareValues(left: unknown, operator: string, right: unknown): boolean {
  if (operator === "===") return left === right;
  if (operator === "!==") return left !== right;
  if (operator === "==") return left === right || String(left) === String(right);
  if (operator === "!=") return !(left === right || String(left) === String(right));
  if (typeof left !== "number" || typeof right !== "number") return false;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  return false;
}

function evaluateStateCondition(path: string, operator: string, rawRight: string, statData: Record<string, unknown>): boolean {
  const right = parseComparisonValue(rawRight);
  if (right === undefined) return false;
  return compareValues(readStatePath(statData, path), operator, right);
}

/** Materializes the simple EJS if/else chains commonly used by MVU stage lore. */
function materializeSafeStateEjs(content: string, statData: Record<string, unknown> | null | undefined): string | null {
  if (!isDynamicEntry({ content } as WorldBookEntry) || !statData) return null;
  const ifPattern = /^<%_?\s*if\s*\(\s*getvar\(\s*(['"])stat_data\.([^'"]+)\1(?:\s*,[^)]*)?\)\s*(<=|>=|===|!==|==|!=|<|>)\s*([^)]*?)\s*\)\s*\{\s*_?%>$/;
  const elseIfPattern = /^<%_?\s*\}\s*else\s+if\s*\(\s*getvar\(\s*(['"])stat_data\.([^'"]+)\1(?:\s*,[^)]*)?\)\s*(<=|>=|===|!==|==|!=|<|>)\s*([^)]*?)\s*\)\s*\{\s*_?%>$/;
  const elsePattern = /^<%_?\s*\}\s*else\s*\{\s*_?%>$/;
  const endPattern = /^<%_?\s*\}\s*_?%>$/;
  const output: string[] = [];
  let branch: { taken: boolean; active: boolean } | null = null;

  for (const line of content.split(/\r?\n/)) {
    const tag = line.trim();
    const ifMatch = tag.match(ifPattern);
    if (ifMatch) {
      if (branch) return null;
      const active = evaluateStateCondition(ifMatch[2], ifMatch[3], ifMatch[4], statData);
      branch = { taken: active, active };
      continue;
    }
    const elseIfMatch = tag.match(elseIfPattern);
    if (elseIfMatch) {
      if (!branch) return null;
      const active = !branch.taken
        && evaluateStateCondition(elseIfMatch[2], elseIfMatch[3], elseIfMatch[4], statData);
      branch.active = active;
      branch.taken ||= active;
      continue;
    }
    if (elsePattern.test(tag)) {
      if (!branch) return null;
      branch.active = !branch.taken;
      branch.taken = true;
      continue;
    }
    if (endPattern.test(tag)) {
      if (!branch) return null;
      branch = null;
      continue;
    }
    if (tag.includes("<%")) return null;
    if (!branch || branch.active) output.push(line);
  }
  return branch ? null : output.join("\n").trim();
}

function isStateMacroEntry(entry: WorldBookEntry): boolean {
  return /\{\{format_message_variable::stat_data\}\}/i.test(entry.content);
}

function passesProbability(entry: WorldBookEntry, random: () => number): boolean {
  if (!entry.useProbability || entry.probability >= 100) return true;
  if (entry.probability <= 0) return false;
  return random() * 100 < entry.probability;
}

function selectGroupWinners(entries: WorldBookEntry[], random: () => number): WorldBookEntry[] {
  const ungrouped = entries.filter((entry) => !entry.group);
  const groups = new Map<string, WorldBookEntry[]>();
  for (const entry of entries) {
    if (!entry.group) continue;
    const existing = groups.get(entry.group) ?? [];
    existing.push(entry);
    groups.set(entry.group, existing);
  }

  for (const groupEntries of groups.values()) {
    const total = groupEntries.reduce((sum, entry) => sum + Math.max(0, entry.groupWeight), 0);
    if (total <= 0) {
      ungrouped.push(groupEntries[0]);
      continue;
    }
    let target = random() * total;
    let winner = groupEntries.at(-1)!;
    for (const entry of groupEntries) {
      target -= Math.max(0, entry.groupWeight);
      if (target < 0) {
        winner = entry;
        break;
      }
    }
    ungrouped.push(winner);
  }
  return ungrouped;
}

/**
 * Safe server-side subset of SillyTavern World Info activation.
 * It reads text entries only and deliberately never evaluates EJS/JavaScript.
 */
export function activateWorldBook(
  entries: WorldBookEntry[],
  messages: ChatMessage[],
  options: SelectionOptions,
): ActivatedWorldBook {
  const random = options.random ?? Math.random;
  const eligible = entries.filter((entry) => entry.enabled && entry.content.trim());
  let skippedDynamic = 0;
  const materialized = eligible.flatMap((entry): WorldBookEntry[] => {
    if (!isDynamicEntry(entry)) return [entry];
    const content = materializeSafeStateEjs(entry.content, options.statData);
    if (!content) {
      skippedDynamic += 1;
      return [];
    }
    return [{ ...entry, content }];
  });
  // MVU already materializes this macro with the actual current snapshot.
  const staticEntries = materialized.filter((entry) => !isStateMacroEntry(entry));
  const selected = new Set<WorldBookEntry>();
  const probabilityChecked = new Set<WorldBookEntry>();
  let recursiveCorpus = "";

  for (let pass = 0; pass < MAX_RECURSION_PASSES; pass += 1) {
    let added = false;
    for (const entry of staticEntries) {
      if (selected.has(entry) || (pass > 0 && entry.preventRecursion)) continue;
      // A failed probability roll is final for this generation round.
      if (probabilityChecked.has(entry)) continue;
      const depth = entry.scanDepth ?? DEFAULT_SCAN_DEPTH;
      const directCorpus = extendedCorpus(
        entry,
        messageCorpus(messages, options.pendingUserText ?? "", depth),
        options,
      );
      const corpus = pass === 0 ? directCorpus : `${directCorpus}\n${recursiveCorpus}`;
      if (!matchesEntry(entry, corpus, options)) continue;
      probabilityChecked.add(entry);
      if (!passesProbability(entry, random)) continue;
      selected.add(entry);
      added = true;
      if (!entry.excludeRecursion) {
        recursiveCorpus += `\n${substitute(entry.content, options.characterName, options.userName)}`;
      }
    }
    if (!added) break;
  }

  const grouped = selectGroupWinners([...selected], random)
    .sort((left, right) => right.insertionOrder - left.insertionOrder);
  const maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS);
  const included: WorldBookEntry[] = [];
  let used = 0;
  let truncated = false;
  for (const entry of grouped) {
    const length = substitute(entry.content, options.characterName, options.userName).length;
    if (!entry.ignoreBudget && used + length > maxChars) {
      truncated = true;
      continue;
    }
    included.push(entry);
    used += length;
  }

  return {
    beforeCharacter: included.filter((entry) => /before/i.test(entry.position)),
    afterCharacter: included.filter((entry) => !/before/i.test(entry.position)),
    skippedDynamic,
    truncated,
  };
}

export function renderWorldBookEntries(
  entries: WorldBookEntry[],
  characterName: string,
  userName: string,
): string {
  return entries
    .map((entry) => substitute(entry.content, characterName, userName).trim())
    .filter(Boolean)
    .join("\n\n");
}
