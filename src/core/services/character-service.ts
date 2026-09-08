import crypto from "node:crypto";
import type { CharacterCardDetails, CharacterSummary, ChatMessage, ChatSearchResult, StoredChatSession } from "../models/index";
import { StClient } from "../../infra/st/st-client";
import { normalizeChatFileName, timestampToMillis } from "../../infra/st/st-chat-mapper";
import { attachMvuSnapshot, createMvuTurnContext, processMvuReply } from "./mvu-service";

function applyPlaceholders(input: string, characterName: string, userName: string): string {
  return input
    .replaceAll("{{char}}", characterName)
    .replaceAll("{{user}}", userName);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function buildChatFileId(characterName: string, now = new Date()): string {
  const safeName = characterName.replaceAll("/", "-").trim() || "New Chat";
  return [
    safeName,
    " - ",
    now.getFullYear(),
    "-",
    pad(now.getMonth() + 1),
    "-",
    pad(now.getDate()),
    "@",
    pad(now.getHours()),
    "h",
    pad(now.getMinutes()),
    "m",
    pad(now.getSeconds()),
    "s",
    pad(now.getMilliseconds(), 3),
    "ms",
  ].join("");
}

function buildChatMetadata(userName: string, characterName: string): ChatMessage {
  return {
    chat_metadata: {
      integrity: crypto.randomUUID(),
      chat_id_hash: Date.now(),
      note_prompt: "",
      note_interval: 1,
      note_position: 1,
      note_depth: 4,
      note_role: 0,
      timedWorldInfo: {
        sticky: {},
        cooldown: {},
      },
      tainted: false,
    },
    user_name: userName,
    character_name: characterName,
  };
}

function buildAssistantOpeningMessage(characterName: string, text: string, snapshot: Record<string, unknown> | null): ChatMessage {
  return attachMvuSnapshot({
    name: characterName,
    is_user: false,
    is_system: false,
    send_date: new Date().toISOString(),
    mes: text,
    extra: {},
  }, snapshot);
}

export class CharacterService {
  private readonly stClient: StClient;

  public constructor(stClient: StClient) {
    this.stClient = stClient;
  }

  public listCharacters(): Promise<CharacterSummary[]> {
    return this.stClient.listCharacters();
  }

  public getCharacterCard(avatar: string): Promise<CharacterCardDetails> {
    return this.stClient.getCharacterCard(avatar);
  }

  public listCharacterChats(avatar: string): Promise<ChatSearchResult[]> {
    return this.stClient.listCharacterChats(avatar);
  }

  public async listAllChats(): Promise<StoredChatSession[]> {
    const characters = await this.stClient.listCharacters();
    const results = await Promise.allSettled(
      characters.map(async (character) => {
        const chats = await this.stClient.listCharacterChats(character.avatar);
        return chats.map((chat) => ({
          ...chat,
          avatar: character.avatar,
          characterName: character.name,
        }));
      }),
    );

    return results
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .sort((left, right) => timestampToMillis(right.lastMessageAt) - timestampToMillis(left.lastMessageAt));
  }

  public async createChatFromCharacter(avatar: string): Promise<StoredChatSession> {
    const [card, settings] = await Promise.all([
      this.stClient.getCharacterCard(avatar),
      this.stClient.getGenerationSettings(),
    ]);
    const chatFile = buildChatFileId(card.name);
    const openingText = applyPlaceholders(
      card.firstMes.trim() || `你好，我是${card.name}。我们开始新的故事吧。`,
      card.name,
      settings.username,
    ).trim();
    const mvuContext = createMvuTurnContext(card, [], settings.username);
    const mvu = processMvuReply(openingText, mvuContext);
    if (mvu?.error) {
      console.warn(JSON.stringify({ scope: "mvu", event: "opening_patch_ignored", error: mvu.error }));
    }

    await this.stClient.saveChat({
      avatar,
      characterName: card.name,
      chatFile,
      chat: [
        buildChatMetadata(settings.username, card.name),
        buildAssistantOpeningMessage(card.name, openingText, mvu?.snapshot ?? mvuContext?.snapshot ?? null),
      ],
    });

    return {
      avatar,
      characterName: card.name,
      fileId: chatFile,
      fileName: normalizeChatFileName(chatFile),
      fileSize: "0 KB",
      messageCount: 1,
      lastMessageAt: new Date().toISOString(),
      previewMessage: openingText,
    };
  }
}
