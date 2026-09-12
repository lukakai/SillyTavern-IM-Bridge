import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/core/models/index";
import {
  ChatEditService,
  removeLastTurnsMessages,
} from "../src/core/services/chat-edit-service";
import { SessionTaskQueue } from "../src/core/services/session-task-queue";

function threeTurnChat(): ChatMessage[] {
  return [
    { chat_metadata: {} },
    { name: "用户", is_user: true, mes: "问题一" },
    { name: "角色", is_user: false, mes: "回答一" },
    { name: "用户", is_user: true, mes: "问题二" },
    { name: "角色", is_user: false, mes: "回答二" },
    { name: "用户", is_user: true, mes: "问题三" },
    { name: "角色", is_user: false, mes: "回答三" },
  ];
}

describe("ChatEditService multi-turn undo", () => {
  it("removes the requested turns from newest to oldest", () => {
    const result = removeLastTurnsMessages(threeTurnChat(), 2);
    expect(result.chat.map((message) => message.mes).filter(Boolean)).toEqual(["问题一", "回答一"]);
    expect(result.removed.map((turn) => turn.userMessage?.text)).toEqual(["问题三", "问题二"]);
  });

  it("rejects an excessive count without saving a partial result", async () => {
    const saveChat = vi.fn(async () => undefined);
    const stClient = {
      getChatMessages: vi.fn(async () => threeTurnChat()),
      saveChat,
    };
    const service = new ChatEditService(
      stClient as never,
      {} as never,
      new SessionTaskQueue(),
      {} as never,
    );

    await expect(service.deleteLastTurns({
      accountId: "account",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      count: 4,
    })).rejects.toThrow("当前会话只有 3 轮可删除");
    expect(saveChat).not.toHaveBeenCalled();
  });
});
