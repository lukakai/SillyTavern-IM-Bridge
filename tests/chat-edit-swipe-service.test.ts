import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/core/models/index";
import { ChatEditService } from "../src/core/services/chat-edit-service";
import { SessionTaskQueue } from "../src/core/services/session-task-queue";

function chat(): ChatMessage[] {
  return [
    { chat_metadata: {} },
    { name: "用户", is_user: true, mes: "原消息", extra: { display_text: "旧显示文本", keep: true } },
    {
      name: "角色",
      is_user: false,
      mes: "原回复",
      swipe_id: 0,
      swipes: ["原回复"],
      variables: [{ stat_data: { 数值: 1 } }],
      variables_initialized: [true],
      extra: {},
    },
  ];
}

function service(initialChat: ChatMessage[], candidate?: ChatMessage) {
  let currentChat = structuredClone(initialChat);
  const saveChat = vi.fn(async (params: { chat: ChatMessage[] }) => {
    currentChat = structuredClone(params.chat);
  });
  const stClient = {
    getChatMessages: vi.fn(async () => structuredClone(currentChat)),
    saveChat,
    getCharacterCard: vi.fn(async () => ({
      avatar: "card.png",
      name: "角色",
      description: "",
      personality: "",
      scenario: "",
      firstMes: "",
      mesExample: "",
      mvu: null,
      xuanxiang: null,
    })),
    getGenerationSettings: vi.fn(async () => ({ username: "用户" })),
  };
  const conversation = {
    generateReplyCandidateStreamWithinLock: vi.fn(async () => ({
      replyText: String(candidate?.mes ?? "新回复"),
      assistantMessage: candidate ?? { name: "角色", is_user: false, mes: "新回复", extra: {} },
      latestRecord: null,
      mvuStatus: candidate?.variables ? { statData: { 数值: 2 }, rangeHints: {} } : null,
    })),
  };
  const instance = new ChatEditService(
    stClient as never,
    conversation as never,
    new SessionTaskQueue(),
    {} as never,
  );
  return { instance, stClient, conversation, saveChat, getChat: () => currentChat };
}

const params = {
  accountId: "account",
  avatar: "card.png",
  characterName: "角色",
  chatFile: "chat.jsonl",
};

describe("ChatEditService Telegram edit and swipe flow", () => {
  it("edits only the latest user message and keeps the existing reply", async () => {
    const fixture = service(chat());
    const result = await fixture.instance.editLatestUserMessage({ ...params, text: "修改后的消息" });
    expect(result).toEqual({ swipeIndex: 0, swipeCount: 1 });
    expect(fixture.getChat()[1]).toMatchObject({ mes: "修改后的消息", extra: { keep: true } });
    expect(fixture.getChat()[1].extra).not.toHaveProperty("display_text");
    expect(fixture.getChat()[2].mes).toBe("原回复");
    expect(fixture.conversation.generateReplyCandidateStreamWithinLock).not.toHaveBeenCalled();
  });

  it("generates a new candidate from the edited user text and appends one swipe", async () => {
    const candidate: ChatMessage = {
      name: "角色",
      is_user: false,
      mes: "新备选",
      variables: [{ stat_data: { 数值: 2 } }],
      extra: {},
    };
    const fixture = service(chat(), candidate);
    await fixture.instance.editLatestUserMessage({ ...params, text: "最新编辑内容" });
    const result = await fixture.instance.appendLastReplySwipe(params);

    expect(result).toMatchObject({ replyText: "新备选", swipeIndex: 1, swipeCount: 2 });
    expect(fixture.getChat()[1].mes).toBe("最新编辑内容");
    expect(fixture.getChat()[2].swipes).toEqual(["原回复", "新备选"]);
    const generationCall = fixture.conversation.generateReplyCandidateStreamWithinLock.mock.calls[0][0];
    expect(generationCall.prefetchedChat.at(-1).mes).toBe("最新编辑内容");
    expect(generationCall.prefetchedChat.some((message: ChatMessage) => message.mes === "原回复")).toBe(false);
  });

  it("rejects a twenty-first candidate without calling the model", async () => {
    const fullChat = chat();
    fullChat[2] = {
      ...fullChat[2],
      mes: "备选 20",
      swipe_id: 19,
      swipes: Array.from({ length: 20 }, (_, index) => `备选 ${index + 1}`),
    };
    const fixture = service(fullChat);

    await expect(fixture.instance.appendLastReplySwipe(params)).rejects.toThrow("当前回复已有 20 个备选");
    expect(fixture.conversation.generateReplyCandidateStreamWithinLock).not.toHaveBeenCalled();
    expect(fixture.saveChat).not.toHaveBeenCalled();
  });
});
