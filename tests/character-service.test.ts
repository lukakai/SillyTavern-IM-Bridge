import { describe, expect, it, vi } from "vitest";
import { CharacterService } from "../src/core/services/character-service";

describe("CharacterService alternate greetings", () => {
  it("lists and creates a chat with the selected opening", async () => {
    const saveChat = vi.fn(async () => undefined);
    const stClient = {
      getCharacterCard: vi.fn(async () => ({
        avatar: "luo.png",
        name: "洛云希",
        description: "",
        personality: "",
        scenario: "",
        firstMes: "你好，{{user}}。",
        alternateGreetings: ["备用开头一", "备用开头二"],
        mesExample: "",
        mvu: null,
        xuanxiang: null,
      })),
      getGenerationSettings: vi.fn(async () => ({ username: "哥哥" })),
      saveChat,
    };
    const service = new CharacterService(stClient as never);

    await expect(service.listCharacterOpenings("luo.png")).resolves.toEqual([
      "你好，哥哥。",
      "备用开头一",
      "备用开头二",
    ]);
    const created = await service.createChatFromCharacter("luo.png", 2);
    expect(created.characterName).toBe("洛云希");
    expect(saveChat).toHaveBeenCalledOnce();
    expect(saveChat.mock.calls[0][0].chat[1].mes).toBe("备用开头二");
  });

  it("rejects an invalid opening index without writing a chat", async () => {
    const saveChat = vi.fn(async () => undefined);
    const stClient = {
      getCharacterCard: vi.fn(async () => ({
        avatar: "card.png",
        name: "角色",
        description: "",
        personality: "",
        scenario: "",
        firstMes: "开头",
        alternateGreetings: [],
        mesExample: "",
        mvu: null,
        xuanxiang: null,
      })),
      getGenerationSettings: vi.fn(async () => ({ username: "用户" })),
      saveChat,
    };
    const service = new CharacterService(stClient as never);
    await expect(service.createChatFromCharacter("card.png", 1)).rejects.toThrow("开场白不存在");
    expect(saveChat).not.toHaveBeenCalled();
  });
});
