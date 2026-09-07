import { describe, expect, it } from "vitest";
import { renderTelegramResponse } from "../src/delivery/telegram/render";

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
  });

  it("leaves regular replies unchanged except for content wrappers", () => {
    const rendered = renderTelegramResponse("<content>普通回复</content>");

    expect(rendered.text).toBe("普通回复");
    expect(rendered.keyboard).toBeNull();
  });
});
