import { InlineKeyboard } from "grammy";
import type {
  GlobalPromptEntry,
  GlobalPromptLayoutSection,
  GlobalSettingsSnapshot,
} from "../../core/services/web-relay-service";

export interface PromptMenuGroup {
  name: string;
  entries: GlobalPromptEntry[];
}

export interface PromptMenuSection {
  name: string;
  groups: PromptMenuGroup[];
}

function compactHeading(name: string): string {
  return name
    .replace(/[━═─]{2,}/g, " ")
    .replace(/[┏┣┗┳┻┫]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || name.trim();
}

function displayName(name: string, limit = 160): string {
  return name.length > limit ? `${name.slice(0, Math.max(1, limit - 1))}…` : name;
}

function countEntries(entries: GlobalPromptEntry[]): { enabled: number; total: number } {
  return {
    enabled: entries.filter((entry) => entry.enabled).length,
    total: entries.length,
  };
}

function ensureSection(sections: PromptMenuSection[], name: string): PromptMenuSection {
  const section: PromptMenuSection = { name, groups: [] };
  sections.push(section);
  return section;
}

function ensureGroup(section: PromptMenuSection, name: string): PromptMenuGroup {
  const group: PromptMenuGroup = { name, entries: [] };
  section.groups.push(group);
  return group;
}

function groupPromptsFromLayout(
  prompts: GlobalPromptEntry[],
  layout: GlobalPromptLayoutSection[],
): PromptMenuSection[] {
  const promptsById = new Map(prompts.filter(prompt => prompt.toggleable).map(prompt => [prompt.identifier, prompt]));
  const used = new Set<string>();
  return layout
    .map(section => ({
      name: section.name,
      groups: section.groups.map(group => ({
        name: group.name,
        entries: group.identifiers.flatMap((identifier) => {
          const prompt = promptsById.get(identifier);
          if (!prompt || used.has(identifier)) return [];
          used.add(identifier);
          return [prompt];
        }),
      })).filter(group => group.entries.length > 0),
    }))
    .filter(section => section.groups.length > 0);
}

export function groupGlobalPrompts(
  prompts: GlobalPromptEntry[],
  layout: GlobalPromptLayoutSection[] = [],
): PromptMenuSection[] {
  const custom = groupPromptsFromLayout(prompts, layout);
  if (custom.length > 0) return custom;

  const sections: PromptMenuSection[] = [];
  let section: PromptMenuSection | null = null;
  let group: PromptMenuGroup | null = null;

  for (const prompt of prompts) {
    if (prompt.empty && /[━═─]{3,}/.test(prompt.name)) {
      section = ensureSection(sections, compactHeading(prompt.name));
      group = null;
      continue;
    }
    if (prompt.empty) {
      section ??= ensureSection(sections, "其他");
      group = ensureGroup(section, compactHeading(prompt.name));
      continue;
    }
    if (!prompt.toggleable) continue;
    section ??= ensureSection(sections, "其他");
    group ??= ensureGroup(section, "未分组");
    group.entries.push(prompt);
  }

  return sections
    .map((item) => ({
      ...item,
      groups: item.groups.filter((candidate) => candidate.entries.length > 0),
    }))
    .filter((item) => item.groups.length > 0);
}

function promptSections(snapshot: GlobalSettingsSnapshot): PromptMenuSection[] {
  return groupGlobalPrompts(snapshot.prompts, snapshot.promptLayout);
}

function hasCustomPromptLayout(snapshot: GlobalSettingsSnapshot): boolean {
  return snapshot.promptLayout.length > 0 && groupPromptsFromLayout(snapshot.prompts, snapshot.promptLayout).length > 0;
}

function activePresetProfile(snapshot: GlobalSettingsSnapshot): string | null {
  return snapshot.presetProfiles.find(profile => profile.active)?.label ?? null;
}

function pageBounds(total: number, page: number, pageSize: number): {
  safePage: number;
  totalPages: number;
  offset: number;
} {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(Math.floor(page), 0), totalPages - 1);
  return { safePage, totalPages, offset: safePage * pageSize };
}

function navigation(
  keyboard: InlineKeyboard,
  safePage: number,
  totalPages: number,
  callback: (page: number) => string,
): void {
  if (safePage > 0) keyboard.text("上一页", callback(safePage - 1));
  if (safePage < totalPages - 1) keyboard.text("下一页", callback(safePage + 1));
}

function settingsHeader(snapshot: GlobalSettingsSnapshot): string[] {
  const lines = [
    `连接配置：${snapshot.currentProfile ? displayName(snapshot.currentProfile) : "未选择"}`,
    `聊天预设：${snapshot.currentPreset ? displayName(snapshot.currentPreset) : "未知"}`,
    `当前模型：${snapshot.currentModel ? displayName(snapshot.currentModel) : "未知"}`,
  ];
  const presetProfile = activePresetProfile(snapshot);
  if (snapshot.presetProfiles.length > 0) {
    lines.push(`预设内模型方案：${presetProfile ? displayName(presetProfile) : "自定义组合"}`);
  }
  return lines;
}

export function renderGlobalProfilePage(
  snapshot: GlobalSettingsSnapshot,
  page: number,
  pageSize: number,
): { text: string; keyboard: InlineKeyboard } {
  const { safePage, totalPages, offset } = pageBounds(snapshot.profiles.length, page, pageSize);
  const items = snapshot.profiles.slice(offset, offset + pageSize);
  const lines = ["酒馆全局连接配置", "", ...settingsHeader(snapshot), "", "选择后会对所有聊天生效：", ""];
  items.forEach((name, index) => {
    lines.push(`${offset + index + 1}. ${displayName(name)}${name === snapshot.currentProfile ? " [当前]" : ""}`);
  });
  if (items.length === 0) lines.push("酒馆 Connection Manager 中还没有保存配置。");
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  items.forEach((_name, index) => {
    keyboard.text(String(offset + index + 1), `gapi:s:${safePage}:${index}`);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  if (snapshot.undoAvailable) keyboard.text("↩️ 撤销上次全局修改", "gsettings:undo").row();
  navigation(keyboard, safePage, totalPages, target => `gapi:p:${target}`);
  return { text: lines.join("\n"), keyboard };
}

export function renderGlobalPresetPage(
  snapshot: GlobalSettingsSnapshot,
  page: number,
  pageSize: number,
): { text: string; keyboard: InlineKeyboard } {
  const { safePage, totalPages, offset } = pageBounds(snapshot.presets.length, page, pageSize);
  const items = snapshot.presets.slice(offset, offset + pageSize);
  const lines = ["酒馆全局聊天预设", "", ...settingsHeader(snapshot), "", "选择后会对所有聊天生效：", ""];
  items.forEach((name, index) => {
    lines.push(`${offset + index + 1}. ${displayName(name)}${name === snapshot.currentPreset ? " [当前]" : ""}`);
  });
  if (items.length === 0) lines.push("当前 API 没有可用聊天预设。");
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  items.forEach((_name, index) => {
    keyboard.text(String(offset + index + 1), `gpreset:s:${safePage}:${index}`);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  keyboard.text("🧩 调整当前预设内部选项", "gprompt:sections:0").row();
  if (snapshot.undoAvailable) keyboard.text("↩️ 撤销上次全局修改", "gsettings:undo").row();
  navigation(keyboard, safePage, totalPages, target => `gpreset:p:${target}`);
  return { text: lines.join("\n"), keyboard };
}

export function renderPromptSections(
  snapshot: GlobalSettingsSnapshot,
  page: number,
  pageSize: number,
): { text: string; keyboard: InlineKeyboard } {
  const sections = promptSections(snapshot);
  const customLayout = hasCustomPromptLayout(snapshot);
  const categories = customLayout
    ? sections.flatMap((section, sectionIndex) => section.groups.map((group, groupIndex) => ({
      name: group.name,
      zone: section.name,
      entries: group.entries,
      callback: `gprompt:group:${sectionIndex}:${groupIndex}:0`,
    })))
    : sections.map((section, sectionIndex) => ({
      name: section.name,
      zone: null,
      entries: section.groups.flatMap(group => group.entries),
      callback: `gprompt:section:${sectionIndex}:0`,
    }));
  const { safePage, totalPages, offset } = pageBounds(categories.length, page, pageSize);
  const items = categories.slice(offset, offset + pageSize);
  const lines = [`当前预设：${snapshot.currentPreset ? displayName(snapshot.currentPreset) : "未知"}`];
  if (snapshot.presetProfiles.length > 0) {
    lines.push(`预设内模型方案：${activePresetProfile(snapshot) ?? "自定义组合"}`);
  }
  lines.push("", "请选择选项分类：", "");
  items.forEach((category, index) => {
    const counts = countEntries(category.entries);
    const zone = category.zone ? `${displayName(category.zone)} · ` : "";
    lines.push(`${offset + index + 1}. ${zone}${displayName(category.name)} (${counts.enabled}/${counts.total})`);
  });
  if (items.length === 0) lines.push("当前预设中没有可通过 Telegram 切换的自定义条目。");
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  snapshot.presetProfiles.forEach((profile, index) => {
    keyboard.text(`${profile.active ? "✅ " : ""}${displayName(profile.label, 24)}`, `gpmode:s:${index}`);
    if ((index + 1) % 2 === 0 || index === snapshot.presetProfiles.length - 1) keyboard.row();
  });
  items.forEach((category, index) => {
    keyboard.text(String(offset + index + 1), category.callback);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  keyboard.text("⬅️ 返回预设", "gpreset:p:0").row();
  navigation(keyboard, safePage, totalPages, target => `gprompt:sections:${target}`);
  return { text: lines.join("\n"), keyboard };
}

export function renderPromptGroups(
  snapshot: GlobalSettingsSnapshot,
  sectionIndex: number,
  page: number,
  pageSize: number,
): { text: string; keyboard: InlineKeyboard } | null {
  const sections = promptSections(snapshot);
  const section = sections[sectionIndex];
  if (!section) return null;
  const { safePage, totalPages, offset } = pageBounds(section.groups.length, page, pageSize);
  const items = section.groups.slice(offset, offset + pageSize);
  const lines = [
    `当前预设：${snapshot.currentPreset ? displayName(snapshot.currentPreset) : "未知"}`,
    `分类：${displayName(section.name)}`,
    "",
    "请选择分组：",
    "",
  ];
  items.forEach((group, index) => {
    const counts = countEntries(group.entries);
    lines.push(`${offset + index + 1}. ${displayName(group.name)} (${counts.enabled}/${counts.total})`);
  });
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  items.forEach((_group, index) => {
    keyboard.text(String(offset + index + 1), `gprompt:group:${sectionIndex}:${offset + index}:0`);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  keyboard.text("⬅️ 返回分类", "gprompt:sections:0").row();
  navigation(keyboard, safePage, totalPages, target => `gprompt:section:${sectionIndex}:${target}`);
  return { text: lines.join("\n"), keyboard };
}

export function renderPromptOptions(
  snapshot: GlobalSettingsSnapshot,
  sectionIndex: number,
  groupIndex: number,
  page: number,
  pageSize: number,
): { text: string; keyboard: InlineKeyboard } | null {
  const sections = promptSections(snapshot);
  const section = sections[sectionIndex];
  const group = section?.groups[groupIndex];
  if (!section || !group) return null;
  const { safePage, totalPages, offset } = pageBounds(group.entries.length, page, pageSize);
  const items = group.entries.slice(offset, offset + pageSize);
  const counts = countEntries(group.entries);
  const lines = [
    `当前预设：${snapshot.currentPreset ? displayName(snapshot.currentPreset) : "未知"}`,
    `${displayName(section.name)} → ${displayName(group.name)} (${counts.enabled}/${counts.total})`,
    "",
  ];
  items.forEach((entry, index) => {
    lines.push(`${offset + index + 1}. ${entry.enabled ? "✅" : "⬜"} ${displayName(entry.name)}`);
  });
  lines.push("", `第 ${safePage + 1} / ${totalPages} 页`);

  const keyboard = new InlineKeyboard();
  items.forEach((entry, index) => {
    keyboard.text(`${entry.enabled ? "✅" : "⬜"} ${offset + index + 1}`, `gprompt:q:${sectionIndex}:${groupIndex}:${safePage}:${offset + index}`);
    if ((index + 1) % 4 === 0 || index === items.length - 1) keyboard.row();
  });
  keyboard
    .text("全部启用", `gprompt:bq:${sectionIndex}:${groupIndex}:${safePage}:1`)
    .text("全部禁用", `gprompt:bq:${sectionIndex}:${groupIndex}:${safePage}:0`)
    .row();
  keyboard.text(
    hasCustomPromptLayout(snapshot) ? "⬅️ 返回分类" : "⬅️ 返回分组",
    hasCustomPromptLayout(snapshot) ? "gprompt:sections:0" : `gprompt:section:${sectionIndex}:0`,
  ).row();
  navigation(keyboard, safePage, totalPages, target => `gprompt:group:${sectionIndex}:${groupIndex}:${target}`);
  return { text: lines.join("\n"), keyboard };
}

export function renderPromptChangePreview(
  snapshot: GlobalSettingsSnapshot,
  sectionIndex: number,
  groupIndex: number,
  page: number,
  optionIndex: number,
): { text: string; keyboard: InlineKeyboard } | null {
  const group = promptSections(snapshot)[sectionIndex]?.groups[groupIndex];
  const entry = group?.entries[optionIndex];
  if (!group || !entry) return null;
  const nextEnabled = !entry.enabled;
  const keyboard = new InlineKeyboard()
    .text(nextEnabled ? "✅ 确认启用" : "✅ 确认禁用", `gprompt:a:${sectionIndex}:${groupIndex}:${page}:${optionIndex}:${nextEnabled ? 1 : 0}`)
    .text("取消", `gprompt:group:${sectionIndex}:${groupIndex}:${page}`);
  return {
    text: [
      "确认修改酒馆全局预设选项？",
      "",
      `当前预设：${snapshot.currentPreset ? displayName(snapshot.currentPreset) : "未知"}`,
      `选项：${displayName(entry.name, 500)}`,
      `修改：${entry.enabled ? "启用" : "禁用"} → ${nextEnabled ? "启用" : "禁用"}`,
      "",
      "确认后会对所有角色和聊天生效，并保留一次撤销快照。",
    ].join("\n"),
    keyboard,
  };
}

export function renderPromptBulkPreview(
  snapshot: GlobalSettingsSnapshot,
  sectionIndex: number,
  groupIndex: number,
  page: number,
  enabled: boolean,
): { text: string; keyboard: InlineKeyboard } | null {
  const section = promptSections(snapshot)[sectionIndex];
  const group = section?.groups[groupIndex];
  if (!section || !group) return null;
  const keyboard = new InlineKeyboard()
    .text(enabled ? "✅ 确认全部启用" : "✅ 确认全部禁用", `gprompt:ba:${sectionIndex}:${groupIndex}:${page}:${enabled ? 1 : 0}`)
    .text("取消", `gprompt:group:${sectionIndex}:${groupIndex}:${page}`);
  return {
    text: [
      "确认批量修改酒馆全局预设选项？",
      "",
      `当前预设：${snapshot.currentPreset ? displayName(snapshot.currentPreset) : "未知"}`,
      `分组：${displayName(section.name)} → ${displayName(group.name)}`,
      `操作：${enabled ? "全部启用" : "全部禁用"}（${group.entries.length} 项）`,
      "",
      "确认后会对所有角色和聊天生效，并保留一次撤销快照。",
    ].join("\n"),
    keyboard,
  };
}
