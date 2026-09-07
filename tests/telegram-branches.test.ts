import { describe, expect, it } from "vitest";
import { renderTelegramResponse, splitTelegramResponse } from "../src/delivery/telegram/render";

describe("renderTelegramResponse", () => {
  it("turns SillyTavern branch markup into Telegram buttons", () => {
    const rendered = renderTelegramResponse([
      "<content>",
      "剧情正文。",
      "</content>",
      "<branches>",
      "<details><summary>🧩Select</summary>",
      "A. 第一个选择",
      "B. 第二个选择",
      "补充说明",
      "C. 第三个选择",
      "</details>",
      "</branches>",
    ].join("\n"));

    expect(rendered.text).toBe([
      "剧情正文。",
      "",
      "请选择：",
      "",
      "A. 第一个选择",
      "B. 第二个选择\n补充说明",
      "C. 第三个选择",
    ].join("\n"));
    expect(rendered.keyboard?.inline_keyboard.flat()).toEqual([
      { text: "A", callback_data: "branch:A" },
      { text: "B", callback_data: "branch:B" },
      { text: "C", callback_data: "branch:C" },
    ]);
    expect(rendered.entities).toEqual([]);
  });

  it("leaves regular replies unchanged except for content wrappers", () => {
    const rendered = renderTelegramResponse("<content>普通回复</content>");

    expect(rendered.text).toBe("普通回复");
    expect(rendered.entities).toEqual([]);
    expect(rendered.keyboard).toBeNull();
  });

  it("renders subtext thinking as a native expandable blockquote", () => {
    const thought = "内部推演第一行。\n内部推演第二行。";
    const rendered = renderTelegramResponse([
      "<!-- begin_of_Subtext_think -->",
      thought,
      "<!-- end_of_Subtext_think -->",
      "</thinking>",
      "### 正文",
      "<!-- Prism：这段注释不应发到 Telegram。 -->",
      "这里是用户可见正文。",
    ].join("\n"));
    const label = "💭 思考过程（点击展开）\n";

    expect(rendered.text).toBe(`${label}${thought}\n\n这里是用户可见正文。`);
    expect(rendered.entities).toEqual([{
      type: "expandable_blockquote",
      offset: label.length,
      length: thought.length,
    }]);
    expect(rendered.keyboard).toBeNull();
  });

  it("clips expandable thought entities when a long reply is split", () => {
    const rendered = renderTelegramResponse([
      "<think>",
      "第一段思考。第二段思考。第三段思考。",
      "</think>",
      "正文。",
    ].join("\n"));
    const parts = splitTelegramResponse(rendered, 25);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((part) => part.entities?.some((entity) => entity.type === "expandable_blockquote"))).toBe(true);
    for (const part of parts) {
      for (const entity of part.entities ?? []) {
        expect(entity.offset).toBeGreaterThanOrEqual(0);
        expect(entity.offset + entity.length).toBeLessThanOrEqual(part.text.length);
      }
    }
  });
});
