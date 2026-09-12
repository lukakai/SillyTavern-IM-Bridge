import { describe, expect, it, vi } from "vitest";
import type { RecentSession } from "../src/core/models/index";
import { CharacterService } from "../src/core/services/character-service";
import { renderRecentSessionsPage } from "../src/delivery/telegram/render";

const recent: RecentSession[] = [
  {
    accountId: "account",
    characterAvatar: "a.png",
    characterName: "角色 A",
    chatFile: "chat-a",
    activeModelOverride: null,
    lastUsedAt: "2026-09-12T10:00:00.000Z",
  },
  {
    accountId: "account",
    characterAvatar: "a.png",
    characterName: "角色 A",
    chatFile: "chat-b.jsonl",
    activeModelOverride: null,
    lastUsedAt: "2026-09-12T09:00:00.000Z",
  },
];

describe("recent session previews", () => {
  it("loads each character chat list once and matches normalized file names", async () => {
    const listCharacterChats = vi.fn(async () => [{
      fileId: "chat-a.jsonl",
      fileName: "chat-a.jsonl",
      fileSize: "2 KB",
      messageCount: 12,
      lastMessageAt: "2026-09-12T11:00:00.000Z",
      previewMessage: "最后一条\n消息",
    }]);
    const service = new CharacterService({ listCharacterChats } as never);
    const previews = await service.addRecentSessionPreviews(recent);

    expect(listCharacterChats).toHaveBeenCalledOnce();
    expect(previews[0]).toMatchObject({ messageCount: 12, previewMessage: "最后一条\n消息" });
    expect(previews[1]).toMatchObject({ messageCount: null, previewMessage: null });

    const rendered = renderRecentSessionsPage(previews);
    expect(rendered.text).toContain("12 条消息");
    expect(rendered.text).toContain("最后：最后一条 消息");
    expect(rendered.keyboard.inline_keyboard.flat()).toContainEqual({ text: "1", callback_data: "recent:0" });
  });

  it("keeps the basic recent list when ST summary lookup fails", async () => {
    const service = new CharacterService({
      listCharacterChats: vi.fn(async () => { throw new Error("ST unavailable"); }),
    } as never);
    await expect(service.addRecentSessionPreviews(recent.slice(0, 1))).resolves.toMatchObject([{
      messageCount: null,
      lastMessageAt: recent[0].lastUsedAt,
      previewMessage: null,
    }]);
  });
});
