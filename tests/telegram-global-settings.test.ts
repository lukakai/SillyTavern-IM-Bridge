import { describe, expect, it } from "vitest";
import type { GlobalPromptEntry, GlobalSettingsSnapshot } from "../src/core/services/web-relay-service";
import {
  groupGlobalPrompts,
  renderGlobalPresetPage,
  renderGlobalProfilePage,
  renderPromptBulkPreview,
  renderPromptChangePreview,
  renderPromptGroups,
  renderPromptOptions,
  renderPromptSections,
} from "../src/delivery/telegram/global-settings";

function prompt(
  identifier: string,
  name: string,
  enabled: boolean,
  options: Partial<Pick<GlobalPromptEntry, "toggleable" | "empty">> = {},
): GlobalPromptEntry {
  return {
    identifier,
    name,
    enabled,
    toggleable: options.toggleable ?? true,
    empty: options.empty ?? false,
  };
}

const snapshot: GlobalSettingsSnapshot = {
  currentProfile: "连接二",
  profiles: ["连接一", "连接二", "连接三"],
  currentPreset: "剧情预设",
  presets: ["简洁预设", "剧情预设", "长篇预设"],
  currentModel: "model-a",
  prompts: [
    prompt("heading-story", "━━━━ 剧情控制 ━━━━", true, { toggleable: false, empty: true }),
    prompt("group-style", "文风", true, { toggleable: false, empty: true }),
    prompt("style-a", "细腻叙事", true),
    prompt("style-b", "快速推进", false),
    prompt("marker", "系统 Marker", true, { toggleable: false }),
    prompt("group-format", "格式", true, { toggleable: false, empty: true }),
    prompt("format-a", "使用章节标题", true),
    prompt("heading-extra", "━━━━ 额外功能 ━━━━", true, { toggleable: false, empty: true }),
    prompt("group-extra", "实验项", true, { toggleable: false, empty: true }),
    prompt("extra-a", "实验开关", false),
  ],
  undoAvailable: true,
  undoSavedAt: "2026-09-12T00:00:00.000Z",
};

describe("Telegram global settings menus", () => {
  it("groups ordered prompt entries into section, group, and toggleable options", () => {
    const sections = groupGlobalPrompts(snapshot.prompts);
    expect(sections.map(section => section.name)).toEqual(["剧情控制", "额外功能"]);
    expect(sections[0].groups.map(group => group.name)).toEqual(["文风", "格式"]);
    expect(sections[0].groups[0].entries.map(entry => entry.identifier)).toEqual(["style-a", "style-b"]);
    expect(sections.flatMap(section => section.groups).flatMap(group => group.entries))
      .not.toContainEqual(expect.objectContaining({ identifier: "marker" }));
  });

  it("renders paged profile and preset selectors using compact index callbacks", () => {
    const profiles = renderGlobalProfilePage(snapshot, 1, 2);
    expect(profiles.text).toContain("连接三");
    expect(profiles.keyboard.inline_keyboard.flat()).toContainEqual({ text: "3", callback_data: "gapi:s:1:0" });
    expect(profiles.keyboard.inline_keyboard.flat()).toContainEqual({ text: "上一页", callback_data: "gapi:p:0" });

    const presets = renderGlobalPresetPage(snapshot, 0, 2);
    expect(presets.text).toContain("剧情预设 [当前]");
    expect(presets.keyboard.inline_keyboard.flat()).toContainEqual({ text: "🧩 调整当前预设内部选项", callback_data: "gprompt:sections:0" });
    expect(presets.keyboard.inline_keyboard.flat()).toContainEqual({ text: "下一页", callback_data: "gpreset:p:1" });
  });

  it("renders all three prompt menu levels and confirmation screens", () => {
    const sections = renderPromptSections(snapshot, 0, 1);
    expect(sections.text).toContain("剧情控制 (2/3)");
    expect(sections.keyboard.inline_keyboard.flat()).toContainEqual({ text: "1", callback_data: "gprompt:section:0:0" });

    const groups = renderPromptGroups(snapshot, 0, 0, 1)!;
    expect(groups.text).toContain("文风 (1/2)");
    expect(groups.keyboard.inline_keyboard.flat()).toContainEqual({ text: "1", callback_data: "gprompt:group:0:0:0" });

    const options = renderPromptOptions(snapshot, 0, 0, 0, 1)!;
    expect(options.text).toContain("✅ 细腻叙事");
    expect(options.keyboard.inline_keyboard.flat()).toContainEqual({ text: "✅ 1", callback_data: "gprompt:q:0:0:0:0" });
    expect(options.keyboard.inline_keyboard.flat().every(button => (button.callback_data?.length ?? 0) <= 64)).toBe(true);

    const single = renderPromptChangePreview(snapshot, 0, 0, 0, 1)!;
    expect(single.text).toContain("快速推进");
    expect(single.text).toContain("禁用 → 启用");
    expect(single.keyboard.inline_keyboard.flat()).toContainEqual({ text: "✅ 确认启用", callback_data: "gprompt:a:0:0:0:1:1" });

    const bulk = renderPromptBulkPreview(snapshot, 0, 0, 0, false)!;
    expect(bulk.text).toContain("全部禁用（2 项）");
    expect(bulk.keyboard.inline_keyboard.flat()).toContainEqual({ text: "✅ 确认全部禁用", callback_data: "gprompt:ba:0:0:0:0" });
  });
});
