import { Bot, Context } from "grammy";
import { Buffer } from "node:buffer";
import type { AppServices } from "../../plugin/build-services";
import type {
  CharacterSummary,
  ChatSearchResult,
  ModelSummary,
  WorldBookEntryView,
  WorldBookSummary,
  WorldBookView,
} from "../../core/models/index";
import type { GlobalSettingsSnapshot } from "../../core/services/web-relay-service";
import { AppError } from "../../shared/errors/app-error";
import { buildSessionKey, createRequestId } from "../../shared/utils/ids";
import {
  COMPRESSION_MODEL_CALLBACK_PREFIX,
  groupModelsByProvider,
  renderCharactersPage,
  renderCharacterModeSelection,
  renderGreetingSelection,
  renderCompressProgress,
  renderCompressResult,
  renderCurrentState,
  renderHelp,
  renderHistoryPage,
  renderLastTurn,
  renderLatestDialogue,
  renderModelPage,
  renderProviderModelPage,
  renderProviderPage,
  renderRecentSessionsPage,
  renderTelegramResponse,
  renderUndoResults,
  splitTelegramResponse,
  splitTelegramText,
} from "./render";
import { StreamRenderer } from "./stream-renderer";
import {
  combineInlineKeyboards,
  decodeSwipeCallback,
  renderSwipeKeyboard,
  type TelegramSwipeAction,
} from "./swipe";
import {
  applyXuanxiangAction,
  createStoredXuanxiang,
  decodeStoredXuanxiang,
  decodeXuanxiangCallback,
  formatXuanxiangSelection,
  renderXuanxiangPanel,
  type StoredXuanxiang,
} from "./xuanxiang";
import {
  renderWorldBookChangePreview,
  renderWorldBookEntriesPage,
  renderWorldBookEntry,
  renderWorldBookPage,
} from "./world-book";
import { WorldBookMessageCleanup } from "./world-book-cleanup";
import { buildHealthSnapshot, renderHealthSnapshot } from "../../plugin/health";
import {
  groupGlobalPrompts,
  renderGlobalPresetPage,
  renderGlobalProfilePage,
  renderPromptBulkPreview,
  renderPromptChangePreview,
  renderPromptGroups,
  renderPromptOptions,
  renderPromptSections,
} from "./global-settings";

type BotContext = Context;

interface GreetingMenuState {
  accountId: string;
  chatId: string;
  avatar: string;
  characterName: string;
  greetings: string[];
  index: number;
  messageIds: number[];
}

const greetingMenus = new Map<string, GreetingMenuState>();

interface WorldBookPendingChange {
  entryRef: string;
  expectedRevision: string;
  content?: string;
  enabled?: boolean;
  constant?: boolean;
}

interface WorldBookMenuState {
  accountId: string;
  chatId: number;
  userId: string;
  books: WorldBookSummary[];
  bookScope: "all" | "current";
  scopeLabel: string | null;
  bookSearch: string;
  currentBook: WorldBookView | null;
  entrySearch: string;
  selectedEntryRef: string | null;
  messageId: number | null;
  editPromptMessageId: number | null;
  pending: WorldBookPendingChange | null;
  saving: boolean;
  cleanup: WorldBookMessageCleanup;
  expiresAt: number;
}

const worldBookMenus = new Map<string, WorldBookMenuState>();
const WORLD_BOOK_MENU_TTL_MS = 30 * 60 * 1000;
const WORLD_BOOK_EDIT_TTL_MS = 24 * 60 * 60 * 1000;
const WORLD_BOOK_MESSAGE_IDLE_MS = 15 * 60 * 1000;

export interface BotRuntimeConfig {
  pageSize: number;
  tgStreamMinRenderIntervalMs: number;
  tgStreamMinDeltaChars: number;
  tgStreamFirstRenderMinChars: number;
  tgStreamHardChunkSize: number;
  tgStreamProgressSingleMessageOnly: boolean;
  tgDisableProgressWhenDegraded: boolean;
}

export interface BotInstanceContext {
  accountId: string;
  config: BotRuntimeConfig;
  sender: import("./telegram-sender").TelegramSender;
}

function getTelegramUserId(ctx: BotContext): string | null {
  return ctx.from?.id ? String(ctx.from.id) : null;
}

async function requireAuthorized(ctx: BotContext, deps: AppServices, botCtx: BotInstanceContext): Promise<string | null> {
  const userId = getTelegramUserId(ctx);
  if (!userId) {
    return null;
  }
  if (!deps.accountConfigService.isTelegramUserAllowed(botCtx.accountId, userId)) {
    await replyText(ctx, botCtx, "未授权：当前 Telegram 用户不在白名单中。");
    return null;
  }
  deps.accountConfigService.linkTelegramIdentity(botCtx.accountId, userId);
  return userId;
}

function getAccountId(_userId: string, _deps: AppServices, botCtx: BotInstanceContext): string {
  return botCtx.accountId;
}

async function requireWorldBookAdmin(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
): Promise<boolean> {
  if (deps.repositories.accountRepository.getSTUserAccount(accountId)?.role === "admin") return true;
  await replyText(ctx, botCtx, "只有 SillyTavern 管理员账号绑定的 Bot 可以管理世界书。", { priority: "critical" });
  return false;
}

async function requireGlobalSettingsAdmin(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
): Promise<boolean> {
  if (deps.repositories.accountRepository.getSTUserAccount(accountId)?.role === "admin") return true;
  await replyText(ctx, botCtx, "只有 SillyTavern 管理员账号绑定的 Bot 可以修改全局 API、模型和预设。", { priority: "critical" });
  return false;
}

async function getCharacters(deps: AppServices): Promise<CharacterSummary[]> {
  return deps.characterService.listCharacters();
}

async function getModels(accountId: string, deps: AppServices): Promise<{ models: ModelSummary[]; currentModel: string }> {
  const [result, snapshot] = await Promise.all([
    deps.modelService.listAvailableModels(accountId),
    getGlobalSettings(accountId, deps),
  ]);
  return {
    models: result.items,
    currentModel: snapshot.currentModel ?? result.currentModel,
  };
}

async function getCompressionModels(accountId: string, deps: AppServices): Promise<{ models: ModelSummary[]; currentModel: string }> {
  const result = await deps.modelService.listCompressionModels(accountId);
  return {
    models: result.items,
    currentModel: result.overrideModel ?? result.currentModel,
  };
}

async function getCurrentCharacterChats(accountId: string, deps: AppServices): Promise<{ characterName: string; avatar: string; chats: ChatSearchResult[] } | null> {
  const state = deps.sessionService.getActiveSession(accountId);
  if (!state?.activeCharacterAvatar || !state.activeCharacterName) {
    return null;
  }

  const chats = await deps.characterService.listCharacterChats(state.activeCharacterAvatar);
  return {
    characterName: state.activeCharacterName,
    avatar: state.activeCharacterAvatar,
    chats,
  };
}

function encodeCallbackToken(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCallbackToken(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

async function replyCharacters(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  page = 0,
  search = "",
): Promise<void> {
  const allCharacters = await getCharacters(deps);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const characters = normalizedSearch
    ? allCharacters.filter((character) => `${character.name} ${character.avatar}`.toLocaleLowerCase().includes(normalizedSearch))
    : allCharacters;
  const searchToken = normalizedSearch ? encodeCallbackToken(search.trim()) : "";
  const rendered = renderCharactersPage(characters, page, botCtx.config.pageSize, searchToken, search.trim());
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyCharacterMode(ctx: BotContext, botCtx: BotInstanceContext, characterName: string): Promise<void> {
  const rendered = renderCharacterModeSelection(characterName);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyGreetingSelection(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  index = 0,
): Promise<void> {
  const state = deps.sessionService.getActiveSession(accountId);
  if (!state?.activeCharacterAvatar || !state.activeCharacterName) {
    await replyText(ctx, botCtx, "当前还没有选择角色，请先使用 /chars。");
    return;
  }
  const greetings = await deps.characterService.listCharacterOpenings(state.activeCharacterAvatar);
  if (greetings.length <= 1) {
    const chatId = ctx.chat?.id;
    if (chatId) greetingMenus.delete(`${accountId}:${chatId}`);
    await createNewChat(ctx, deps, botCtx, accountId, 0);
    return;
  }
  const rendered = renderGreetingSelection(state.activeCharacterName, greetings, index);
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await replyText(ctx, botCtx, "无法确定 Telegram 会话，请重新使用 /new。", { priority: "critical" });
    return;
  }
  const key = `${accountId}:${chatId}`;
  const previous = greetingMenus.get(key);
  const messageIds = await renderGreetingMenu(ctx, botCtx, chatId, rendered.text, rendered.keyboard, previous?.messageIds ?? []);
  greetingMenus.set(key, {
    accountId,
    chatId: String(chatId),
    avatar: state.activeCharacterAvatar,
    characterName: state.activeCharacterName,
    greetings,
    index: Math.min(Math.max(Math.floor(index), 0), greetings.length - 1),
    messageIds,
  });
}

async function createNewChat(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  openingIndex: number,
): Promise<void> {
  const state = deps.sessionService.getActiveSession(accountId);
  if (!state?.activeCharacterAvatar || !state.activeCharacterName) {
    await replyText(ctx, botCtx, "当前还没有选择角色，请先使用 /chars。");
    return;
  }
  const created = await deps.characterService.createChatFromCharacter(state.activeCharacterAvatar, openingIndex);
  deps.sessionService.setActiveSession(accountId, created.avatar, created.characterName, created.fileId);
  const latestRecord = await deps.stClient.getLatestDialogueRecord(created.avatar, created.fileId);
  await replyLongText(ctx, botCtx, renderLatestDialogue(created.characterName, created.fileId, latestRecord));
}

async function replyHistory(ctx: BotContext, deps: AppServices, accountId: string, botCtx: BotInstanceContext, page = 0): Promise<void> {
  const result = await getCurrentCharacterChats(accountId, deps);
  if (!result) {
    await replyText(ctx, botCtx, "当前还没有选择角色。请先使用 /characters。");
    return;
  }

  if (result.chats.length === 0) {
    await replyText(ctx, botCtx, `角色 ${result.characterName} 当前没有可选的历史会话。`);
    return;
  }

  const rendered = renderHistoryPage(result.characterName, result.chats, page, botCtx.config.pageSize);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyModels(ctx: BotContext, deps: AppServices, accountId: string, botCtx: BotInstanceContext, page = 0): Promise<void> {
  const { models, currentModel } = await getModels(accountId, deps);
  if (models.length === 0) {
    await replyText(ctx, botCtx, "ST 当前没有返回可用模型列表。");
    return;
  }

  const groups = groupModelsByProvider(models);
  const rendered = renderProviderPage(groups, currentModel, page, botCtx.config.pageSize);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyProviderModels(
  ctx: BotContext,
  deps: AppServices,
  accountId: string,
  botCtx: BotInstanceContext,
  providerIdx: number,
  page = 0,
): Promise<void> {
  const { models, currentModel } = await getModels(accountId, deps);
  if (models.length === 0) {
    await replyText(ctx, botCtx, "ST 当前没有返回可用模型列表。");
    return;
  }

  const groups = groupModelsByProvider(models);
  const group = groups[providerIdx];
  if (!group) {
    await replyText(ctx, botCtx, "供应商选择已失效，请重新执行 /model。");
    return;
  }

  const rendered = renderProviderModelPage(group, providerIdx, currentModel, page, botCtx.config.pageSize);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyCompressionModels(ctx: BotContext, deps: AppServices, accountId: string, botCtx: BotInstanceContext, page = 0): Promise<void> {
  const { models, currentModel } = await getCompressionModels(accountId, deps);
  if (models.length === 0) {
    await replyText(ctx, botCtx, "ST 当前没有返回可用模型列表。");
    return;
  }

  const groups = groupModelsByProvider(models);
  const rendered = renderProviderPage(groups, currentModel, page, botCtx.config.pageSize, COMPRESSION_MODEL_CALLBACK_PREFIX);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyCompressionProviderModels(
  ctx: BotContext,
  deps: AppServices,
  accountId: string,
  botCtx: BotInstanceContext,
  providerIdx: number,
  page = 0,
): Promise<void> {
  const { models, currentModel } = await getCompressionModels(accountId, deps);
  if (models.length === 0) {
    await replyText(ctx, botCtx, "ST 当前没有返回可用模型列表。");
    return;
  }

  const groups = groupModelsByProvider(models);
  const group = groups[providerIdx];
  if (!group) {
    await replyText(ctx, botCtx, "供应商选择已失效，请重新执行 /cmodel。");
    return;
  }

  const rendered = renderProviderModelPage(group, providerIdx, currentModel, page, botCtx.config.pageSize, COMPRESSION_MODEL_CALLBACK_PREFIX);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function getGlobalSettings(accountId: string, deps: AppServices): Promise<GlobalSettingsSnapshot> {
  return deps.webRelayService.executeControl({ accountId, operation: "settings_snapshot" });
}

async function replyGlobalProfiles(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  page = 0,
): Promise<void> {
  const snapshot = await getGlobalSettings(accountId, deps);
  const rendered = renderGlobalProfilePage(snapshot, page, botCtx.config.pageSize);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function replyGlobalPresets(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  page = 0,
): Promise<void> {
  const snapshot = await getGlobalSettings(accountId, deps);
  const rendered = renderGlobalPresetPage(snapshot, page, botCtx.config.pageSize);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function editGlobalSettingsMessage(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  rendered: { text: string; keyboard: unknown },
): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId && messageId) {
    try {
      await botCtx.sender.editText(ctx, chatId, messageId, rendered.text, {
        priority: "critical",
        replyMarkup: rendered.keyboard,
      });
      return;
    } catch {
      // Telegram can reject edits for expired messages; send a fresh menu instead.
    }
  }
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
}

async function reportGlobalSettingsError(ctx: BotContext, botCtx: BotInstanceContext, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await replyText(ctx, botCtx, `全局设置操作失败：${message}`, { priority: "critical" });
}

type ReplyTextOptions = { reply_markup?: unknown; priority?: "critical" | "normal" | "ephemeral" };

async function replyText(ctx: BotContext, botCtx: BotInstanceContext, text: string, options?: ReplyTextOptions): Promise<{ message_id: number }> {
  return botCtx.sender.reply(ctx, text, {
    replyMarkup: options?.reply_markup,
    priority: options?.priority ?? "normal",
  });
}

async function replyLongText(ctx: BotContext, botCtx: BotInstanceContext, text: string, options?: ReplyTextOptions): Promise<void> {
  const parts = splitTelegramText(text);
  for (const part of parts) {
    await replyText(ctx, botCtx, part, options);
  }
}

function worldBookMenuKey(accountId: string, chatId: number, userId: string): string {
  return `${accountId}:${chatId}:${userId}`;
}

function newWorldBookCleanup(ctx: BotContext, botCtx: BotInstanceContext, chatId: number): WorldBookMessageCleanup {
  return new WorldBookMessageCleanup(
    (messageId) => botCtx.sender.deleteMessage(ctx, chatId, messageId, "normal"),
    WORLD_BOOK_MESSAGE_IDLE_MS,
  );
}

async function replyWorldBookText(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  state: WorldBookMenuState,
  text: string,
  options?: ReplyTextOptions,
): Promise<{ message_id: number }> {
  const message = await replyText(ctx, botCtx, text, options);
  state.cleanup.track(message.message_id);
  return message;
}

function getWorldBookMenu(accountId: string, chatId: number | undefined, userId: string): WorldBookMenuState | null {
  if (!chatId) return null;
  const key = worldBookMenuKey(accountId, chatId, userId);
  const state = worldBookMenus.get(key);
  if (!state) return null;
  if (state.expiresAt <= Date.now()) {
    worldBookMenus.delete(key);
    state.cleanup.resume();
    return null;
  }
  state.expiresAt = Date.now() + (state.editPromptMessageId || state.pending || state.saving
    ? WORLD_BOOK_EDIT_TTL_MS : WORLD_BOOK_MENU_TTL_MS);
  state.cleanup.touch();
  return state;
}

async function replyLongTextWithFinalKeyboard(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  input: string,
  keyboard: unknown,
  cleanup?: WorldBookMessageCleanup,
): Promise<number> {
  const parts = splitTelegramText(input);
  let lastMessageId = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const message = await replyText(ctx, botCtx, parts[index], {
      reply_markup: index === parts.length - 1 ? keyboard : { inline_keyboard: [] },
    });
    cleanup?.track(message.message_id);
    lastMessageId = message.message_id;
  }
  return lastMessageId;
}

async function showWorldBookList(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  state: WorldBookMenuState,
  page = 0,
  refresh = false,
): Promise<void> {
  if (refresh && state.bookScope === "all") {
    state.books = await deps.worldBookAdminService.listWorldBooks(state.bookSearch);
  }
  state.currentBook = null;
  state.entrySearch = "";
  state.selectedEntryRef = null;
  state.editPromptMessageId = null;
  state.pending = null;
  state.expiresAt = Date.now() + WORLD_BOOK_MENU_TTL_MS;
  const rendered = renderWorldBookPage(state.books, page, botCtx.config.pageSize, state.bookSearch);
  const text = state.scopeLabel ? `${state.scopeLabel}\n\n${rendered.text}` : rendered.text;
  const message = await replyWorldBookText(ctx, botCtx, state, text, { reply_markup: rendered.keyboard });
  state.messageId = message.message_id;
  state.cleanup.resume();
}

async function showWorldBookEntries(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  state: WorldBookMenuState,
  page = 0,
): Promise<void> {
  if (!state.currentBook) throw new AppError("WORLD_BOOK_MENU_STALE", "请重新选择世界书。", 400);
  state.selectedEntryRef = null;
  state.editPromptMessageId = null;
  state.pending = null;
  state.expiresAt = Date.now() + WORLD_BOOK_MENU_TTL_MS;
  const rendered = renderWorldBookEntriesPage(
    state.currentBook,
    page,
    botCtx.config.pageSize,
    state.entrySearch,
  );
  const text = state.scopeLabel ? `${state.scopeLabel}\n\n${rendered.text}` : rendered.text;
  const message = await replyWorldBookText(ctx, botCtx, state, text, { reply_markup: rendered.keyboard });
  state.messageId = message.message_id;
  state.cleanup.resume();
}

function selectedWorldBookEntry(state: WorldBookMenuState): WorldBookEntryView | null {
  if (!state.currentBook || !state.selectedEntryRef) return null;
  return state.currentBook.entries.find((entry) => entry.ref === state.selectedEntryRef) ?? null;
}

async function showWorldBookEntry(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  state: WorldBookMenuState,
): Promise<void> {
  if (!state.currentBook) throw new AppError("WORLD_BOOK_MENU_STALE", "请重新选择世界书。", 400);
  const entry = selectedWorldBookEntry(state);
  if (!entry) throw new AppError("WORLD_BOOK_ENTRY_STALE", "请重新选择世界书条目。", 400);
  state.editPromptMessageId = null;
  state.pending = null;
  state.expiresAt = Date.now() + WORLD_BOOK_MENU_TTL_MS;
  const rendered = renderWorldBookEntry(state.currentBook, entry);
  state.messageId = await replyLongTextWithFinalKeyboard(ctx, botCtx, rendered.text, rendered.keyboard, state.cleanup);
  state.cleanup.resume();
}

async function openWorldBookMenu(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  userId: string,
  search = "",
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const books = await deps.worldBookAdminService.listWorldBooks(search);
  const state: WorldBookMenuState = {
    accountId,
    chatId,
    userId,
    books,
    bookScope: "all",
    scopeLabel: null,
    bookSearch: search.trim(),
    currentBook: null,
    entrySearch: "",
    selectedEntryRef: null,
    messageId: null,
    editPromptMessageId: null,
    pending: null,
    saving: false,
    cleanup: newWorldBookCleanup(ctx, botCtx, chatId),
    expiresAt: Date.now() + WORLD_BOOK_MENU_TTL_MS,
  };
  const key = worldBookMenuKey(accountId, chatId, userId);
  worldBookMenus.get(key)?.cleanup.resume();
  worldBookMenus.set(key, state);
  await showWorldBookList(ctx, deps, botCtx, state, 0);
}

async function openCurrentCharacterWorldBookMenu(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  userId: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const active = deps.sessionService.requireActiveSession(accountId);
  const card = await deps.characterService.getCharacterCard(active.activeCharacterAvatar!);
  const reference = card.linkedWorldBook?.trim();
  if (!reference) {
    if (card.embeddedWorldBookName) {
      throw new AppError(
        "CURRENT_WORLD_BOOK_EMBEDDED_ONLY",
        `当前角色没有关联可独立编辑的世界书。检测到角色卡内嵌世界书「${card.embeddedWorldBookName}」，当前版本不会修改角色卡原文件。`,
        400,
      );
    }
    throw new AppError(
      "CURRENT_WORLD_BOOK_MISSING",
      "当前会话角色没有关联独立世界书。请先在 SillyTavern 网页端为该角色选择世界书。",
      400,
    );
  }

  const book = await deps.worldBookAdminService.resolveWorldBook(reference);
  if (!book) {
    throw new AppError(
      "CURRENT_WORLD_BOOK_NOT_FOUND",
      `当前角色关联了世界书「${reference}」，但独立世界书列表中没有找到它。请先在 SillyTavern 网页端检查或重新选择。`,
      404,
    );
  }

  const state: WorldBookMenuState = {
    accountId,
    chatId,
    userId,
    books: [book],
    bookScope: "current",
    scopeLabel: `当前会话角色：${active.activeCharacterName}\n关联独立世界书：${book.name}`,
    bookSearch: "",
    currentBook: await deps.worldBookAdminService.getWorldBook(book.id),
    entrySearch: "",
    selectedEntryRef: null,
    messageId: null,
    editPromptMessageId: null,
    pending: null,
    saving: false,
    cleanup: newWorldBookCleanup(ctx, botCtx, chatId),
    expiresAt: Date.now() + WORLD_BOOK_MENU_TTL_MS,
  };
  const key = worldBookMenuKey(accountId, chatId, userId);
  worldBookMenus.get(key)?.cleanup.resume();
  worldBookMenus.set(key, state);
  await showWorldBookEntries(ctx, botCtx, state, 0);
}

async function handleWorldBookCallback(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  accountId: string,
  userId: string,
  data: string,
): Promise<void> {
  const state = getWorldBookMenu(accountId, ctx.chat?.id, userId);
  const callbackMessageId = Number(ctx.callbackQuery?.message?.message_id ?? 0);
  if (!state || !state.messageId || callbackMessageId !== state.messageId) {
    await ctx.answerCallbackQuery({ text: "这个世界书菜单已失效" });
    await replyText(ctx, botCtx, "世界书菜单已失效，请重新使用 /worldbook。", { priority: "critical" });
    return;
  }

  if (data === "wb:confirm" && state.saving) {
    await ctx.answerCallbackQuery({ text: "正在保存，请稍候" });
    return;
  }

  await ctx.answerCallbackQuery(data === "wb:confirm" ? { text: "正在保存" } : undefined);
  try {
    if (data.startsWith("wb:bp:")) {
      await showWorldBookList(ctx, deps, botCtx, state, Number(data.split(":")[2] ?? 0));
      return;
    }
    if (data.startsWith("wb:b:")) {
      const book = state.books[Number(data.split(":")[2] ?? -1)];
      if (!book) throw new AppError("WORLD_BOOK_MENU_STALE", "世界书选择已失效。", 400);
      state.currentBook = await deps.worldBookAdminService.getWorldBook(book.id);
      state.entrySearch = "";
      await showWorldBookEntries(ctx, botCtx, state, 0);
      return;
    }
    if (data === "wb:books") {
      await showWorldBookList(ctx, deps, botCtx, state, 0, true);
      return;
    }
    if (data.startsWith("wb:ep:")) {
      await showWorldBookEntries(ctx, botCtx, state, Number(data.split(":")[2] ?? 0));
      return;
    }
    if (data === "wb:entries") {
      await showWorldBookEntries(ctx, botCtx, state, 0);
      return;
    }
    if (data.startsWith("wb:e:")) {
      const entry = state.currentBook?.entries[Number(data.split(":")[2] ?? -1)];
      if (!entry) throw new AppError("WORLD_BOOK_ENTRY_STALE", "世界书条目选择已失效。", 400);
      state.selectedEntryRef = entry.ref;
      await showWorldBookEntry(ctx, botCtx, state);
      return;
    }
    if (data === "wb:edit") {
      const entry = selectedWorldBookEntry(state);
      if (!state.currentBook || !entry) throw new AppError("WORLD_BOOK_ENTRY_STALE", "请重新选择世界书条目。", 400);
      state.cleanup.pause();
      const prompt = await replyWorldBookText(ctx, botCtx, state, [
        `请回复这条消息，发送 [${entry.uid}] ${entry.comment || "未命名条目"} 的完整新正文。`,
        "",
        "只会修改正文，不会修改关键词或其他参数。Telegram 单条文本上限约 4096 字符。",
        "如果不想修改，请使用 /wbcancel。",
      ].join("\n"));
      state.editPromptMessageId = prompt.message_id;
      state.messageId = prompt.message_id;
      state.pending = null;
      state.expiresAt = Date.now() + WORLD_BOOK_EDIT_TTL_MS;
      return;
    }
    if (data === "wb:toggle") {
      const entry = selectedWorldBookEntry(state);
      if (!state.currentBook || !entry) throw new AppError("WORLD_BOOK_ENTRY_STALE", "请重新选择世界书条目。", 400);
      state.pending = {
        entryRef: entry.ref,
        expectedRevision: state.currentBook.revision,
        enabled: !entry.enabled,
      };
      state.expiresAt = Date.now() + WORLD_BOOK_EDIT_TTL_MS;
      state.cleanup.pause();
      const rendered = renderWorldBookChangePreview({
        bookName: state.currentBook.name,
        entry,
        nextEnabled: !entry.enabled,
      });
      const message = await replyWorldBookText(ctx, botCtx, state, rendered.text, { reply_markup: rendered.keyboard });
      state.messageId = message.message_id;
      return;
    }
    if (data === "wb:mode") {
      const entry = selectedWorldBookEntry(state);
      if (!state.currentBook || !entry) throw new AppError("WORLD_BOOK_ENTRY_STALE", "请重新选择世界书条目。", 400);
      state.pending = {
        entryRef: entry.ref,
        expectedRevision: state.currentBook.revision,
        constant: !entry.constant,
      };
      state.expiresAt = Date.now() + WORLD_BOOK_EDIT_TTL_MS;
      state.cleanup.pause();
      const rendered = renderWorldBookChangePreview({
        bookName: state.currentBook.name,
        entry,
        nextConstant: !entry.constant,
      });
      const message = await replyWorldBookText(ctx, botCtx, state, rendered.text, { reply_markup: rendered.keyboard });
      state.messageId = message.message_id;
      return;
    }
    if (data === "wb:cancel") {
      state.pending = null;
      await replyWorldBookText(ctx, botCtx, state, "已取消，本次没有修改世界书。");
      await showWorldBookEntry(ctx, botCtx, state);
      return;
    }
    if (data === "wb:confirm") {
      if (!state.currentBook || !state.pending) {
        throw new AppError("WORLD_BOOK_CHANGE_STALE", "待确认的修改已经失效。", 400);
      }
      const entryRef = state.pending.entryRef;
      state.saving = true;
      let result;
      try {
        result = await deps.worldBookAdminService.updateEntry({
          bookId: state.currentBook.id,
          entryRef,
          expectedRevision: state.pending.expectedRevision,
          patch: {
            ...(typeof state.pending.content === "string" ? { content: state.pending.content } : {}),
            ...(typeof state.pending.enabled === "boolean" ? { enabled: state.pending.enabled } : {}),
            ...(typeof state.pending.constant === "boolean" ? { constant: state.pending.constant } : {}),
          },
        });
      } finally {
        state.saving = false;
      }
      state.pending = null;
      state.currentBook = state.entrySearch
        ? await deps.worldBookAdminService.getWorldBook(result.book.id, state.entrySearch)
        : result.book;
      state.selectedEntryRef = entryRef;
      await replyWorldBookText(ctx, botCtx, state, [
        "✅ 世界书已保存。",
        `备份文件：${result.backupFileName}`,
        "下一次网页完整模式生成会自动重新读取世界书缓存。",
      ].join("\n"), { priority: "critical" });
      await showWorldBookEntry(ctx, botCtx, state);
      return;
    }
    throw new AppError("WORLD_BOOK_ACTION_INVALID", "不支持的世界书操作。", 400);
  } catch (error) {
    state.pending = null;
    if (!state.editPromptMessageId) state.expiresAt = Date.now() + WORLD_BOOK_MENU_TTL_MS;
    const message = error instanceof Error ? error.message : String(error);
    await replyWorldBookText(ctx, botCtx, state, `世界书操作失败：${message}`, { priority: "critical" });
    if (!state.editPromptMessageId) state.cleanup.resume();
  }
}

function createStreamRenderer(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  initialMessageId: number,
  xuanxiangCallbackId: number | null = null,
  swipeIndex = 0,
  swipeCount = 1,
): StreamRenderer {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    throw new Error("Telegram chat id missing");
  }

  const degraded = botCtx.sender.isDegraded(chatId);
  return new StreamRenderer(ctx, botCtx.sender, chatId, initialMessageId, {
    minRenderIntervalMs: botCtx.config.tgStreamMinRenderIntervalMs,
    minDeltaChars: botCtx.config.tgStreamMinDeltaChars,
    firstRenderMinChars: botCtx.config.tgStreamFirstRenderMinChars,
    hardChunkSize: botCtx.config.tgStreamHardChunkSize,
    degraded,
    progressSingleMessageOnly: botCtx.config.tgStreamProgressSingleMessageOnly,
    disableProgressWhenDegraded: botCtx.config.tgDisableProgressWhenDegraded,
    xuanxiangCallbackId: xuanxiangCallbackId ? String(xuanxiangCallbackId) : null,
    swipeIndex,
    swipeCount,
  });
}

function getActiveSessionMessage(chatId: number | undefined, accountId: string, deps: AppServices) {
  const state = deps.sessionService.getActiveSession(accountId);
  if (!state?.activeCharacterAvatar || !state.activeCharacterName || !state.activeChatFile) {
    return null;
  }

  return {
    ...state,
    chatId: chatId ? String(chatId) : null,
  };
}

function getLatestTelegramTurn(deps: AppServices, accountId: string, chatId: string, avatar: string, chatFile: string) {
  return getLatestTelegramTurns(deps, accountId, chatId, avatar, chatFile, 1)[0] ?? null;
}

function getLatestTelegramTurns(
  deps: AppServices,
  accountId: string,
  chatId: string,
  avatar: string,
  chatFile: string,
  limit: number,
) {
  return deps.repositories.turnRepository.listLatestActiveTurnRecords({
    accountId,
    channel: "telegram",
    sessionKey: buildSessionKey(avatar, chatFile),
    externalRefMatches: {
      chatId,
    },
    limit: 500,
  }).filter((record) => record.operation === "telegram_send_stream"
    || record.operation === "telegram_redo_stream"
    || (record.operation === null && Boolean(record.clientTurnId)))
    .slice(0, limit);
}

function numericMessageIds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

async function deleteMessagesBestEffort(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  chatId: string | number,
  messageIds: number[],
): Promise<void> {
  for (const messageId of [...messageIds].reverse()) {
    try {
      await botCtx.sender.deleteMessage(ctx, chatId, messageId, "normal");
    } catch {
      // A stale progress message is preferable to losing the completed ST mutation.
    }
  }
}

async function renderGreetingMenu(
  ctx: BotContext,
  botCtx: BotInstanceContext,
  chatId: string | number,
  text: string,
  keyboard: unknown,
  existingMessageIds: number[],
): Promise<number[]> {
  const parts = splitTelegramText(text);
  const messageIds: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const messageId = existingMessageIds[index];
    const replyMarkup = index === parts.length - 1 ? keyboard : { inline_keyboard: [] };
    if (messageId) {
      await botCtx.sender.editText(ctx, chatId, messageId, parts[index], {
        priority: "critical",
        replyMarkup,
      });
      messageIds.push(messageId);
    } else {
      const sent = await botCtx.sender.sendText(ctx, chatId, parts[index], {
        priority: "critical",
        replyMarkup,
      });
      messageIds.push(sent.message_id);
    }
  }
  await deleteMessagesBestEffort(ctx, botCtx, chatId, existingMessageIds.slice(parts.length));
  return messageIds;
}

function storedXuanxiangBySwipe(
  externalRefs: Record<string, unknown>,
  swipeIndex: number,
  swipeCount: number,
): Array<StoredXuanxiang | null> {
  const source = Array.isArray(externalRefs.xuanxiangBySwipe) ? externalRefs.xuanxiangBySwipe : [];
  const result = Array.from({ length: swipeCount }, (_, index) => decodeStoredXuanxiang(source[index]));
  if (!result[swipeIndex]) result[swipeIndex] = decodeStoredXuanxiang(externalRefs.xuanxiang);
  return result;
}

async function renderSelectedSwipe(params: {
  ctx: BotContext;
  botCtx: BotInstanceContext;
  chatId: number;
  recordId: number;
  existingMessageIds: number[];
  replyText: string;
  mvuStatus: import("../../core/models/index").MvuStatusSnapshot | null;
  swipeIndex: number;
  swipeCount: number;
  xuanxiang: StoredXuanxiang | null;
}): Promise<{
  messageIds: number[];
  swipeControlMessageId: number;
  xuanxiangMessageId: number | null;
}> {
  const rendered = renderTelegramResponse(params.replyText, params.mvuStatus, {
    xuanxiangCallbackId: String(params.recordId),
    xuanxiangState: params.xuanxiang?.state,
  });
  const bodyParts = splitTelegramResponse(rendered, params.botCtx.config.tgStreamHardChunkSize);
  if (bodyParts.length === 0) bodyParts.push({ text: "角色回复包含可交互选项，请在下方选择。" });
  const swipeKeyboard = renderSwipeKeyboard(params.recordId, params.swipeIndex, params.swipeCount);
  const desired = bodyParts.map((part, index) => ({
    text: part.text,
    entities: part.entities,
    replyMarkup: index === bodyParts.length - 1
      ? combineInlineKeyboards(rendered.keyboard, swipeKeyboard)
      : undefined,
    xuanxiang: false,
  }));
  if (rendered.xuanxiang) {
    desired.push({
      text: rendered.xuanxiang.text,
      entities: undefined,
      replyMarkup: rendered.xuanxiang.keyboard ?? undefined,
      xuanxiang: true,
    });
  }

  const messageIds: number[] = [];
  for (let index = 0; index < desired.length; index += 1) {
    const part = desired[index];
    const existingId = params.existingMessageIds[index];
    if (existingId) {
      await params.botCtx.sender.editText(params.ctx, params.chatId, existingId, part.text, {
        priority: "critical",
        replyMarkup: part.replyMarkup ?? { inline_keyboard: [] },
        entities: part.entities,
      });
      messageIds.push(existingId);
    } else {
      const sent = await params.botCtx.sender.sendText(params.ctx, params.chatId, part.text, {
        priority: "critical",
        replyMarkup: part.replyMarkup,
        entities: part.entities,
      });
      messageIds.push(sent.message_id);
    }
  }
  await deleteMessagesBestEffort(
    params.ctx,
    params.botCtx,
    params.chatId,
    params.existingMessageIds.slice(desired.length),
  );

  return {
    messageIds,
    swipeControlMessageId: messageIds[bodyParts.length - 1],
    xuanxiangMessageId: rendered.xuanxiang ? messageIds.at(-1) ?? null : null,
  };
}

async function sendConversationText(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  userId: string,
  text: string,
  clientTurnId: string,
  userMessageId: number | null,
): Promise<void> {
  const accountId = getAccountId(userId, deps, botCtx);
  let turnRecordId: number | null = null;

  try {
    const state = deps.sessionService.requireActiveSession(accountId);
    const requestId = createRequestId();
    const traceId = requestId;
    if (ctx.chat?.id) {
      turnRecordId = deps.repositories.turnRepository.createTurnRecord({
        accountId,
        channel: "telegram",
        sessionKey: buildSessionKey(state.activeCharacterAvatar!, state.activeChatFile!),
        clientTurnId,
        requestId,
        traceId,
        operation: "telegram_send_stream",
        status: "started",
        externalRefs: {
          chatId: String(ctx.chat.id),
          ...(userMessageId ? { userMessageId } : {}),
          botMessageIds: [],
          characterAvatar: state.activeCharacterAvatar,
          characterName: state.activeCharacterName,
          chatFile: state.activeChatFile,
        },
      });
    }

    const placeholder = await replyText(ctx, botCtx, "已收到，正在继续当前会话。");
    const streamRenderer = createStreamRenderer(ctx, deps, botCtx, placeholder.message_id, turnRecordId);
    const result = await deps.conversationService.sendMessageStream({
      accountId,
      avatar: state.activeCharacterAvatar!,
      characterName: state.activeCharacterName!,
      chatFile: state.activeChatFile!,
      text,
      modelOverride: state.activeModelOverride,
      onProgress: async (event) => {
        if (event.type === "delta") {
          await streamRenderer.onProgress(event.fullText);
        }
      },
    });

    const xuanxiang = createStoredXuanxiang(result.replyText);
    if (turnRecordId) {
      const pendingTurn = deps.repositories.turnRepository.getTurnRecordById(turnRecordId);
      if (pendingTurn) {
        deps.repositories.turnRepository.updateTurnExternalRefs(turnRecordId, {
          ...pendingTurn.externalRefs,
          xuanxiang,
        });
      }
    }
    await streamRenderer.onDone(result.replyText, result.mvuStatus);

    if (turnRecordId && ctx.chat?.id) {
      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed",
        errorMessage: null,
        externalRefs: {
          chatId: String(ctx.chat.id),
          ...(userMessageId ? { userMessageId } : {}),
          botMessageIds: streamRenderer.getMessageIds(),
          characterAvatar: state.activeCharacterAvatar,
          characterName: state.activeCharacterName,
          chatFile: state.activeChatFile,
          latestMessageId: result.latestRecord?.messageId ?? null,
          latestTurnId: result.latestRecord?.turnId ?? null,
          xuanxiang,
          xuanxiangBySwipe: [xuanxiang],
          xuanxiangMessageId: streamRenderer.getXuanxiangMessageId(),
          swipeIndex: 0,
          swipeCount: 1,
          swipeControlMessageId: streamRenderer.getSwipeControlMessageId(),
        },
      });
    }
  } catch (error) {
    if (turnRecordId) {
      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    const message = error instanceof AppError || error instanceof Error ? error.message : String(error);
    await replyText(ctx, botCtx, `生成失败：${message}`, { priority: "critical" });
  }
}

export function registerHandlers(bot: Bot<BotContext>, deps: AppServices, botCtx: BotInstanceContext): void {
  const activeSwipeOperations = new Set<string>();
  const swipeOperationKey = (accountId: string, avatar: string, chatFile: string): string =>
    `${accountId}:${buildSessionKey(avatar, chatFile)}`;

  bot.command("bind", async (ctx) => {
    const userId = getTelegramUserId(ctx);
    if (!userId) return;
    const text = ctx.message?.text ?? "";
    const code = text.split(/\s+/)[1]?.trim() ?? "";
    if (!code) {
      await replyText(ctx, botCtx, "用法：/bind <验证码>\n请在 SillyTavern 网页端的 IM Bridge 抽屉里点「生成绑定码」获取。");
      return;
    }
    const outcome = deps.bindCodeService.redeem(botCtx.accountId, code, userId);
    switch (outcome) {
      case "ok":
        await replyText(ctx, botCtx, "✅ 绑定成功，现在可以使用 /help 查看命令了。");
        return;
      case "invalid":
        await replyText(ctx, botCtx, "❌ 验证码无效或已被使用。");
        return;
      case "expired":
        await replyText(ctx, botCtx, "⌛ 验证码已过期，请在网页端重新生成。");
        return;
      case "rate_limited":
        await replyText(ctx, botCtx, "⛔ 尝试次数过多，请稍后再试（至多 1 小时）。");
        return;
    }
  });

  bot.command("start", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await replyText(ctx, botCtx, renderHelp());
    await replyCharacters(ctx, deps, botCtx, 0);
  });

  bot.command("help", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await replyText(ctx, botCtx, renderHelp());
  });

  bot.command(["chars", "characters"], async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const search = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
    await replyCharacters(ctx, deps, botCtx, 0, search);
  });

  bot.command(["hist", "history"], async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await replyHistory(ctx, deps, getAccountId(userId, deps, botCtx), botCtx, 0);
  });

  bot.command("recent", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const recentSessions = deps.sessionService.listRecentSessions(accountId, botCtx.config.pageSize);
    if (recentSessions.length === 0) {
      await replyText(ctx, botCtx, "当前还没有最近会话记录。");
      return;
    }

    const previews = await deps.characterService.addRecentSessionPreviews(recentSessions);
    const rendered = renderRecentSessionsPage(previews);
    await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
  });

  bot.command("health", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    await replyText(ctx, botCtx, renderHealthSnapshot(buildHealthSnapshot(deps)));
  });

  bot.command(["worldbook", "wb"], async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireWorldBookAdmin(ctx, deps, botCtx, accountId)) return;
    const argument = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
    try {
      if (argument.toLocaleLowerCase() === "now") {
        await openCurrentCharacterWorldBookMenu(ctx, deps, botCtx, accountId, userId);
      } else {
        await openWorldBookMenu(ctx, deps, botCtx, accountId, userId, argument);
      }
    } catch (error) {
      await replyText(ctx, botCtx, `读取世界书失败：${error instanceof Error ? error.message : String(error)}`, { priority: "critical" });
    }
  });

  bot.command("wbfind", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireWorldBookAdmin(ctx, deps, botCtx, accountId)) return;
    const state = getWorldBookMenu(accountId, ctx.chat?.id, userId);
    if (!state?.currentBook) {
      await replyText(ctx, botCtx, "请先使用 /worldbook 选择一个世界书。", { priority: "critical" });
      return;
    }
    const search = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
    if (!search) {
      await replyText(ctx, botCtx, "用法：/wbfind 关键词\n会搜索当前世界书的条目名称、关键词和正文。");
      return;
    }
    try {
      state.currentBook = await deps.worldBookAdminService.getWorldBook(state.currentBook.id, search);
      state.entrySearch = search;
      await showWorldBookEntries(ctx, botCtx, state, 0);
    } catch (error) {
      await replyText(ctx, botCtx, `搜索世界书失败：${error instanceof Error ? error.message : String(error)}`, { priority: "critical" });
    }
  });

  bot.command("wbcancel", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId || !ctx.chat?.id) return;
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireWorldBookAdmin(ctx, deps, botCtx, accountId)) return;
    const key = worldBookMenuKey(accountId, ctx.chat.id, userId);
    const state = worldBookMenus.get(key);
    worldBookMenus.delete(key);
    if (state) {
      await replyWorldBookText(ctx, botCtx, state, "已退出世界书编辑，本次没有保存任何待确认修改。");
      state.cleanup.resume();
    } else {
      await replyText(ctx, botCtx, "已退出世界书编辑，本次没有保存任何待确认修改。");
    }
  });

  bot.command("model", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireGlobalSettingsAdmin(ctx, deps, botCtx, accountId)) return;
    deps.modelService.clearModelSelection(accountId);
    try {
      await replyModels(ctx, deps, accountId, botCtx, 0);
    } catch (error) {
      await reportGlobalSettingsError(ctx, botCtx, error);
    }
  });

  bot.command(["api", "profile"], async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireGlobalSettingsAdmin(ctx, deps, botCtx, accountId)) return;
    try {
      await replyGlobalProfiles(ctx, deps, botCtx, accountId, 0);
    } catch (error) {
      await reportGlobalSettingsError(ctx, botCtx, error);
    }
  });

  bot.command("preset", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireGlobalSettingsAdmin(ctx, deps, botCtx, accountId)) return;
    try {
      await replyGlobalPresets(ctx, deps, botCtx, accountId, 0);
    } catch (error) {
      await reportGlobalSettingsError(ctx, botCtx, error);
    }
  });

  bot.command("settingsundo", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    if (!await requireGlobalSettingsAdmin(ctx, deps, botCtx, accountId)) return;
    try {
      const snapshot = await deps.webRelayService.executeControl({ accountId, operation: "settings_undo" });
      deps.modelService.clearModelSelection(accountId);
      const rendered = renderGlobalPresetPage(snapshot, 0, botCtx.config.pageSize);
      await replyText(ctx, botCtx, `已撤销上次全局设置修改。\n\n${rendered.text}`, { reply_markup: rendered.keyboard });
    } catch (error) {
      await reportGlobalSettingsError(ctx, botCtx, error);
    }
  });

  bot.command("cmodel", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await replyCompressionModels(ctx, deps, getAccountId(userId, deps, botCtx), botCtx, 0);
  });

  bot.command(["prompt", "promptmode"], async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    const value = (ctx.message?.text ?? "").split(/\s+/)[1]?.trim().toLocaleLowerCase() ?? "";
    const compactAliases = new Set(["compact", "simple", "简化", "精简"]);
    const enhancedAliases = new Set(["enhanced", "完整", "增强"]);
    const webAliases = new Set(["web", "网页", "原生"]);
    if (!value) {
      const current = deps.accountConfigService.getPromptMode(accountId);
      const relay = deps.webRelayService.getStatus(accountId);
      const modeLabel = current === "web" ? "网页完整" : current === "enhanced" ? "增强" : "简化";
      await replyText(ctx, botCtx, [
        `当前提示词模式：${modeLabel}`,
        `网页中继：${relay.online ? `🟢 在线（${relay.workerCount} 个页面）` : "⚪ 离线"}`,
        "",
        "/prompt compact - 简化模式（兼容原有行为）",
        "/prompt enhanced - 增强模式（读取角色卡完整文本、Persona 和文本世界书）",
        "/prompt web - 由已登录的酒馆网页执行原生 Generate 流程",
        "增强模式不会执行角色卡内的 JavaScript/EJS。",
      ].join("\n"));
      return;
    }
    const mode = compactAliases.has(value)
      ? "compact"
      : enhancedAliases.has(value)
        ? "enhanced"
        : webAliases.has(value)
          ? "web"
          : null;
    if (!mode) {
      await replyText(ctx, botCtx, "无法识别该模式。请使用 /prompt compact、/prompt enhanced 或 /prompt web。");
      return;
    }
    if (mode === "web" && !deps.webRelayService.getStatus(accountId).online) {
      await replyText(ctx, botCtx, [
        "网页中继当前离线，尚未切换模式。",
        "请先在 Mac mini 的专用 SillyTavern 页面打开 IM Bridge 设置，点击“在此浏览器启用网页中继”，然后重试 /prompt web。",
      ].join("\n"));
      return;
    }
    deps.accountConfigService.setPromptMode(accountId, mode);
    await replyText(ctx, botCtx, mode === "web"
      ? "✅ 已切换到网页完整模式。后续生成将由在线的 SillyTavern 页面执行，会使用该页面当前的预设、世界书、Persona 与前端扩展。中继离线时会明确报错，不会静默降级。"
      : mode === "enhanced"
        ? "✅ 已切换到增强提示词模式。后续生成会读取角色卡额外提示词、Persona 与文本世界书；不会执行 JavaScript/EJS。"
        : "✅ 已切换到简化提示词模式。后续生成恢复原有的精简提示词与最近 24 条对话。");
  });

  bot.command("compress", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state) {
      await replyText(ctx, botCtx, "当前没有绑定角色和会话。请先使用 /chars 选择角色和历史聊天。");
      return;
    }

    const placeholder = await replyText(ctx, botCtx, "正在压缩当前会话…", { priority: "critical" });
    const placeholderMessageId = placeholder.message_id;
    const chatId = ctx.chat?.id;

    const requestId = createRequestId();
    const traceId = requestId;
    const turnRecordId = deps.repositories.turnRepository.createTurnRecord({
      accountId,
      channel: "telegram",
      sessionKey: buildSessionKey(state.activeCharacterAvatar!, state.activeChatFile!),
      requestId,
      traceId,
      operation: "telegram_compress",
      status: "started",
      externalRefs: state.chatId ? { chatId: state.chatId, placeholderMessageId } : { placeholderMessageId },
    });

    let lastEditedAt = 0;
    const editProgress = async (text: string, force: boolean): Promise<void> => {
      if (!chatId) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastEditedAt < 4000) {
        return;
      }
      lastEditedAt = now;
      try {
        await botCtx.sender.editText(ctx, chatId, placeholderMessageId, text, { priority: "normal" });
      } catch {
        // ignore intermediate edit failures
      }
    };

    try {
      const compressionModelOverride = state.compressionModelOverride
        ?? state.activeModelOverride
        ?? null;

      const result = await deps.compressionService.compressChat({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
        modelOverride: compressionModelOverride,
        onProgress: async (event) => {
          if (event.type === "started") {
            await editProgress(`正在压缩当前会话…\n准备处理 ${event.totalMessages} 条 AI 回复。`, true);
            return;
          }
          if (event.type === "batch_done") {
            await editProgress(renderCompressProgress(event.completedMessages, event.totalMessages), false);
            return;
          }
          if (event.type === "error") {
            await editProgress(`压缩失败：${event.message}`, true);
          }
        },
      });

      const finalText = renderCompressResult(result);
      if (chatId) {
        try {
          await botCtx.sender.editText(ctx, chatId, placeholderMessageId, finalText, { priority: "critical" });
        } catch {
          await replyText(ctx, botCtx, finalText, { priority: "critical" });
        }
      } else {
        await replyText(ctx, botCtx, finalText, { priority: "critical" });
      }

      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed",
        errorMessage: null,
        externalRefs: {
          ...(state.chatId ? { chatId: state.chatId } : {}),
          placeholderMessageId,
          compressedCount: result.compressedCount,
          skippedCount: result.skippedCount,
          backupFile: result.backupFile,
          originalBytes: result.originalBytes,
          compressedBytes: result.compressedBytes,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed",
        errorMessage: message,
      });
      if (chatId) {
        try {
          await botCtx.sender.editText(ctx, chatId, placeholderMessageId, `压缩失败：${message}`, { priority: "critical" });
        } catch {
          await replyText(ctx, botCtx, `压缩失败：${message}`, { priority: "critical" });
        }
      } else {
        await replyText(ctx, botCtx, `压缩失败：${message}`, { priority: "critical" });
      }
    }
  });

  bot.command(["now", "current"], async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = deps.sessionService.getActiveSession(accountId);
    const latestRecord = state?.activeCharacterAvatar && state.activeChatFile
      ? await deps.stClient.getLatestDialogueRecord(state.activeCharacterAvatar, state.activeChatFile)
      : null;

    await replyLongText(ctx, botCtx, renderCurrentState(state, latestRecord));
  });

  bot.command("last", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state) {
      await replyText(ctx, botCtx, "当前没有绑定角色和会话。请先使用 /chars 选择角色和历史聊天。");
      return;
    }

    const details = await deps.chatEditService.getLastTurn({
      avatar: state.activeCharacterAvatar!,
      chatFile: state.activeChatFile!,
    });
    await replyLongText(ctx, botCtx, renderLastTurn(details));
  });

  bot.command("undo", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const args = (ctx.message?.text ?? "").trim().split(/\s+/).slice(1);
    const count = args.length === 0 || (args.length === 1 && args[0] === "")
      ? 1
      : args.length === 1 && /^\d+$/.test(args[0])
        ? Number(args[0])
        : Number.NaN;
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      await replyText(ctx, botCtx, "用法：/undo 或 /undo 2（一次最多删除 10 轮）。");
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state) {
      await replyText(ctx, botCtx, "当前没有绑定角色和会话。请先使用 /chars 选择角色和历史聊天。");
      return;
    }

    const targetTurns = state.chatId
      ? getLatestTelegramTurns(
        deps,
        accountId,
        state.chatId,
        state.activeCharacterAvatar!,
        state.activeChatFile!,
        count,
      )
      : [];

    const requestId = createRequestId();
    const traceId = requestId;
    const turnRecordId = deps.repositories.turnRepository.createTurnRecord({
      accountId,
      channel: "telegram",
      sessionKey: buildSessionKey(state.activeCharacterAvatar!, state.activeChatFile!),
      requestId,
      traceId,
      operation: "telegram_undo",
      status: "started",
      externalRefs: state.chatId ? { chatId: state.chatId, requestedCount: count } : { requestedCount: count },
    });

    try {
      const result = await deps.chatEditService.deleteLastTurns({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
        count,
      });

      for (const targetTurn of targetTurns) {
        deps.repositories.turnRepository.markTurnRevoked(targetTurn.id);
      }
      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed",
        errorMessage: null,
        externalRefs: {
          ...(state.chatId ? { chatId: state.chatId } : {}),
          removedCount: result.removed.length,
          revokedTurnRecordIds: targetTurns.map((turn) => turn.id),
          removedTurns: result.removed.map((details) => ({
            userMessageId: details.userMessage?.messageId ?? null,
            assistantMessageId: details.assistantMessage?.messageId ?? null,
          })),
          latestMessageId: result.latestRecord?.messageId ?? null,
          latestTurnId: result.latestRecord?.turnId ?? null,
        },
      });

      await replyLongText(ctx, botCtx, renderUndoResults(result.removed));
    } catch (error) {
      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      await replyText(ctx, botCtx, `删除失败：${message}`, { priority: "critical" });
    }
  });

  bot.command("redo", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state) {
      await replyText(ctx, botCtx, "当前没有绑定角色和会话。请先使用 /chars 选择角色和历史聊天。");
      return;
    }

    const latestTurn = state.chatId
      ? getLatestTelegramTurn(deps, accountId, state.chatId, state.activeCharacterAvatar!, state.activeChatFile!)
      : null;
    const operationKey = swipeOperationKey(accountId, state.activeCharacterAvatar!, state.activeChatFile!);
    if (activeSwipeOperations.has(operationKey)) {
      await replyText(ctx, botCtx, "当前回复正在处理，请完成后再试。", { priority: "critical" });
      return;
    }
    activeSwipeOperations.add(operationKey);

    const requestId = createRequestId();
    const traceId = requestId;
    const progressChatId = ctx.chat?.id ?? null;
    let progress: StreamRenderer | null = null;

    try {
      if (!latestTurn || !ctx.chat?.id) {
        const placeholder = await replyText(ctx, botCtx, "正在重新生成回复…");
        progress = createStreamRenderer(ctx, deps, botCtx, placeholder.message_id);
        const result = await deps.chatEditService.regenerateLastReply({
          accountId,
          avatar: state.activeCharacterAvatar!,
          characterName: state.activeCharacterName!,
          chatFile: state.activeChatFile!,
          modelOverride: state.activeModelOverride,
          onProgress: async (event) => {
            if (event.type === "delta") await progress!.onProgress(event.fullText);
          },
        });
        await progress.onDone(result.replyText, result.mvuStatus);
        return;
      }

      deps.repositories.turnRepository.updateTurnRecord(latestTurn.id, {
        requestId,
        traceId,
        operation: "telegram_redo_stream",
        status: "started",
        errorMessage: null,
      });
      const placeholder = await replyText(ctx, botCtx, "正在重新生成当前回复…", { priority: "critical" });
      progress = createStreamRenderer(ctx, deps, botCtx, placeholder.message_id);
      const result = await deps.chatEditService.replaceLastReplySwipe({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
        modelOverride: state.activeModelOverride,
        onProgress: async (event) => {
          if (event.type === "delta") await progress!.onProgress(event.fullText);
        },
      });
      await deleteMessagesBestEffort(ctx, botCtx, ctx.chat.id, progress.getMessageIds());
      const oldIndex = Number(latestTurn.externalRefs.swipeIndex ?? 0);
      const bySwipe = storedXuanxiangBySwipe(latestTurn.externalRefs, oldIndex, result.swipeCount);
      const xuanxiang = createStoredXuanxiang(result.replyText);
      bySwipe[result.swipeIndex] = xuanxiang;
      const display = await renderSelectedSwipe({
        ctx,
        botCtx,
        chatId: ctx.chat.id,
        recordId: latestTurn.id,
        existingMessageIds: numericMessageIds(latestTurn.externalRefs.botMessageIds),
        replyText: result.replyText,
        mvuStatus: result.mvuStatus,
        swipeIndex: result.swipeIndex,
        swipeCount: result.swipeCount,
        xuanxiang,
      });
      deps.repositories.turnRepository.updateTurnRecord(latestTurn.id, {
        requestId,
        traceId,
        operation: "telegram_redo_stream",
        status: "completed",
        errorMessage: null,
        externalRefs: {
          ...latestTurn.externalRefs,
          botMessageIds: display.messageIds,
          latestMessageId: result.latestRecord?.messageId ?? null,
          latestTurnId: result.latestRecord?.turnId ?? null,
          swipeIndex: result.swipeIndex,
          swipeCount: result.swipeCount,
          swipeControlMessageId: display.swipeControlMessageId,
          xuanxiang,
          xuanxiangBySwipe: bySwipe,
          xuanxiangMessageId: display.xuanxiangMessageId,
        },
      });
    } catch (error) {
      if (progress && progressChatId) {
        await deleteMessagesBestEffort(ctx, botCtx, progressChatId, progress.getMessageIds());
      }
      if (latestTurn) {
        deps.repositories.turnRepository.updateTurnRecord(latestTurn.id, {
          requestId,
          traceId,
          operation: "telegram_redo_stream",
          status: "completed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      await replyText(ctx, botCtx, `重生成失败：${message}`, { priority: "critical" });
    } finally {
      activeSwipeOperations.delete(operationKey);
    }
  });

  bot.command("revoke", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state || !state.chatId) {
      await replyText(ctx, botCtx, "当前聊天上下文不可用，无法执行撤回。");
      return;
    }

    const turn = getLatestTelegramTurn(deps, accountId, state.chatId, state.activeCharacterAvatar!, state.activeChatFile!);
    if (!turn) {
      await replyText(ctx, botCtx, "当前没有可撤回的最近一轮。只有通过桥接发送的最近一轮才能撤回。");
      return;
    }

    const requestId = createRequestId();
    const traceId = requestId;
    const turnRecordId = deps.repositories.turnRepository.createTurnRecord({
      accountId,
      channel: "telegram",
      sessionKey: buildSessionKey(state.activeCharacterAvatar!, state.activeChatFile!),
      requestId,
      traceId,
      operation: "telegram_revoke",
      status: "started",
      externalRefs: {
        chatId: state.chatId,
        targetTurnRecordId: turn.id,
      },
    });

    try {
      await deps.chatEditService.deleteLastTurn({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
      });
      deps.repositories.turnRepository.markTurnRevoked(turn.id);

      const botMessageIds = Array.isArray(turn.externalRefs.botMessageIds)
        ? (turn.externalRefs.botMessageIds as unknown[]).map((item) => Number(item)).filter((item) => Number.isInteger(item))
        : [];

      const editErrors: string[] = [];
      if (botMessageIds.length > 0) {
        try {
          await botCtx.sender.editText(ctx, ctx.chat!.id, botMessageIds[0], "已撤回", { priority: "critical" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          editErrors.push(`edit:${botMessageIds[0]}:${message}`);
        }

        for (const extraId of botMessageIds.slice(1).reverse()) {
          try {
            await botCtx.sender.deleteMessage(ctx, ctx.chat!.id, extraId, "normal");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            editErrors.push(`delete:${extraId}:${message}`);
          }
        }
      }

      if (editErrors.length > 0) {
        deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
          status: "completed",
          errorMessage: null,
          externalRefs: {
            chatId: state.chatId,
            targetTurnRecordId: turn.id,
            botMessageIds,
            editErrors,
          },
        });
        await replyText(ctx, botCtx, `已回退 ST 最后一轮；Telegram 消息更新部分失败：${editErrors.join(" | ")}`);
      } else {
        deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
          status: "completed",
          errorMessage: null,
          externalRefs: {
            chatId: state.chatId,
            targetTurnRecordId: turn.id,
            botMessageIds,
          },
        });
      }
    } catch (error) {
      deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        externalRefs: {
          chatId: state.chatId,
          targetTurnRecordId: turn.id,
        },
      });
      const message = error instanceof Error ? error.message : String(error);
      await replyText(ctx, botCtx, `撤回失败：${message}`, { priority: "critical" });
    }
  });

  bot.command("new", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const state = deps.sessionService.getActiveSession(accountId);
    if (!state?.activeCharacterAvatar || !state.activeCharacterName) {
      await replyText(ctx, botCtx, "当前还没有选择角色。请先使用 /chars 选择角色，再使用 /new 新建会话。");
      return;
    }

    await replyGreetingSelection(ctx, deps, botCtx, accountId, 0);
  });

  bot.on("callback_query:data", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const data = ctx.callbackQuery.data;

    if (data.startsWith("wb:")) {
      if (!await requireWorldBookAdmin(ctx, deps, botCtx, accountId)) {
        await ctx.answerCallbackQuery({ text: "需要 SillyTavern 管理员权限" });
        return;
      }
      await handleWorldBookCallback(ctx, deps, botCtx, accountId, userId, data);
      return;
    }

    if (data.startsWith("sw:")) {
      const callback = decodeSwipeCallback(data);
      const callbackMessageId = ctx.callbackQuery.message?.message_id;
      const chatId = ctx.chat?.id;
      if (!callback || !callbackMessageId || !chatId) {
        await ctx.answerCallbackQuery({ text: "这个备选操作已经失效" });
        return;
      }

      const turn = deps.repositories.turnRepository.getTurnRecordById(callback.recordId);
      const active = deps.sessionService.getActiveSession(accountId);
      const activeSessionKey = active?.activeCharacterAvatar && active.activeChatFile
        ? buildSessionKey(active.activeCharacterAvatar, active.activeChatFile)
        : null;
      const latestTurn = activeSessionKey
        ? getLatestTelegramTurn(deps, accountId, String(chatId), active!.activeCharacterAvatar!, active!.activeChatFile!)
        : null;
      const controlMessageId = Number(turn?.externalRefs.swipeControlMessageId ?? 0);
      const currentIndex = Number(turn?.externalRefs.swipeIndex ?? 0);
      const currentCount = Math.max(1, Number(turn?.externalRefs.swipeCount ?? 1));

      if (
        !turn
        || turn.accountId !== accountId
        || turn.channel !== "telegram"
        || turn.status !== "completed"
        || turn.revokedAt
        || turn.sessionKey !== activeSessionKey
        || String(turn.externalRefs.chatId ?? "") !== String(chatId)
        || latestTurn?.id !== turn.id
        || controlMessageId !== callbackMessageId
        || !Number.isInteger(currentIndex)
        || currentIndex < 0
        || currentIndex >= currentCount
      ) {
        await ctx.answerCallbackQuery({ text: "这个备选操作已失效，请使用当前会话的最新回复" });
        return;
      }

      if (callback.action === "info") {
        await ctx.answerCallbackQuery({ text: `当前是第 ${currentIndex + 1} / ${currentCount} 条回复` });
        return;
      }

      const operationKey = swipeOperationKey(accountId, active!.activeCharacterAvatar!, active!.activeChatFile!);
      if (activeSwipeOperations.has(operationKey)) {
        await ctx.answerCallbackQuery({ text: "当前回复正在处理，请稍后再点" });
        return;
      }
      activeSwipeOperations.add(operationKey);

      if (callback.action === "previous" || callback.action === "next") {
        const targetIndex = callback.action === "previous" ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= currentCount) {
          activeSwipeOperations.delete(operationKey);
          await ctx.answerCallbackQuery({ text: "已经没有更多备选了" });
          return;
        }
        try {
          await ctx.answerCallbackQuery({ text: `正在切换到第 ${targetIndex + 1} 条回复` });
          const result = await deps.chatEditService.selectLastReplySwipe({
            accountId,
            avatar: active!.activeCharacterAvatar!,
            characterName: active!.activeCharacterName!,
            chatFile: active!.activeChatFile!,
            swipeIndex: targetIndex,
          });
          const bySwipe = storedXuanxiangBySwipe(turn.externalRefs, currentIndex, result.swipeCount);
          const selectedXuanxiang = bySwipe[result.swipeIndex] ?? createStoredXuanxiang(result.replyText);
          bySwipe[result.swipeIndex] = selectedXuanxiang;
          const display = await renderSelectedSwipe({
            ctx,
            botCtx,
            chatId,
            recordId: turn.id,
            existingMessageIds: numericMessageIds(turn.externalRefs.botMessageIds),
            replyText: result.replyText,
            mvuStatus: result.mvuStatus,
            swipeIndex: result.swipeIndex,
            swipeCount: result.swipeCount,
            xuanxiang: selectedXuanxiang,
          });
          deps.repositories.turnRepository.updateTurnExternalRefs(turn.id, {
            ...turn.externalRefs,
            botMessageIds: display.messageIds,
            latestMessageId: result.latestRecord?.messageId ?? null,
            latestTurnId: result.latestRecord?.turnId ?? null,
            swipeIndex: result.swipeIndex,
            swipeCount: result.swipeCount,
            swipeControlMessageId: display.swipeControlMessageId,
            xuanxiang: selectedXuanxiang,
            xuanxiangBySwipe: bySwipe,
            xuanxiangMessageId: display.xuanxiangMessageId,
          });
        } catch (error) {
          await replyText(ctx, botCtx, `切换备选失败：${error instanceof Error ? error.message : String(error)}`, { priority: "critical" });
        } finally {
          activeSwipeOperations.delete(operationKey);
        }
        return;
      }

      const action: Extract<TelegramSwipeAction, "add" | "replace"> = callback.action;
      const requestId = createRequestId();
      let progress: StreamRenderer | null = null;
      try {
        await ctx.answerCallbackQuery({ text: action === "add" ? "正在生成新的备选回复" : "正在重新生成当前回复" });
        deps.repositories.turnRepository.updateTurnRecord(turn.id, {
          requestId,
          traceId: requestId,
          operation: "telegram_redo_stream",
          status: "started",
          errorMessage: null,
        });
        const placeholder = await replyText(
          ctx,
          botCtx,
          action === "add" ? "正在生成新的备选回复…" : "正在重新生成当前回复…",
          { priority: "critical" },
        );
        progress = createStreamRenderer(ctx, deps, botCtx, placeholder.message_id);
        const generate = action === "add"
          ? deps.chatEditService.appendLastReplySwipe.bind(deps.chatEditService)
          : deps.chatEditService.replaceLastReplySwipe.bind(deps.chatEditService);
        const result = await generate({
          accountId,
          avatar: active!.activeCharacterAvatar!,
          characterName: active!.activeCharacterName!,
          chatFile: active!.activeChatFile!,
          modelOverride: active!.activeModelOverride,
          onProgress: async (event) => {
            if (event.type === "delta") await progress!.onProgress(event.fullText);
          },
        });
        await deleteMessagesBestEffort(ctx, botCtx, chatId, progress.getMessageIds());

        const bySwipe = storedXuanxiangBySwipe(turn.externalRefs, currentIndex, result.swipeCount);
        const selectedXuanxiang = createStoredXuanxiang(result.replyText);
        bySwipe[result.swipeIndex] = selectedXuanxiang;
        const display = await renderSelectedSwipe({
          ctx,
          botCtx,
          chatId,
          recordId: turn.id,
          existingMessageIds: numericMessageIds(turn.externalRefs.botMessageIds),
          replyText: result.replyText,
          mvuStatus: result.mvuStatus,
          swipeIndex: result.swipeIndex,
          swipeCount: result.swipeCount,
          xuanxiang: selectedXuanxiang,
        });
        deps.repositories.turnRepository.updateTurnRecord(turn.id, {
          requestId,
          traceId: requestId,
          operation: "telegram_redo_stream",
          status: "completed",
          errorMessage: null,
          externalRefs: {
            ...turn.externalRefs,
            botMessageIds: display.messageIds,
            latestMessageId: result.latestRecord?.messageId ?? null,
            latestTurnId: result.latestRecord?.turnId ?? null,
            swipeIndex: result.swipeIndex,
            swipeCount: result.swipeCount,
            swipeControlMessageId: display.swipeControlMessageId,
            xuanxiang: selectedXuanxiang,
            xuanxiangBySwipe: bySwipe,
            xuanxiangMessageId: display.xuanxiangMessageId,
          },
        });
      } catch (error) {
        if (progress) {
          await deleteMessagesBestEffort(ctx, botCtx, chatId, progress.getMessageIds());
        }
        deps.repositories.turnRepository.updateTurnRecord(turn.id, {
          requestId,
          traceId: requestId,
          operation: "telegram_redo_stream",
          status: "completed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        await replyText(
          ctx,
          botCtx,
          `${action === "add" ? "生成备选" : "重新生成"}失败：${error instanceof Error ? error.message : String(error)}`,
          { priority: "critical" },
        );
      } finally {
        activeSwipeOperations.delete(operationKey);
      }
      return;
    }

    if (data.startsWith("xq:")) {
      const callback = decodeXuanxiangCallback(data);
      const callbackMessageId = ctx.callbackQuery.message?.message_id;
      const chatId = ctx.chat?.id;
      if (!callback || !callbackMessageId || !chatId) {
        await ctx.answerCallbackQuery({ text: "这个选项已经失效" });
        return;
      }

      const turn = deps.repositories.turnRepository.getTurnRecordById(callback.recordId);
      const active = deps.sessionService.getActiveSession(accountId);
      const activeSessionKey = active?.activeCharacterAvatar && active.activeChatFile
        ? buildSessionKey(active.activeCharacterAvatar, active.activeChatFile)
        : null;
      const latestTurn = activeSessionKey
        ? getLatestTelegramTurn(deps, accountId, String(chatId), active!.activeCharacterAvatar!, active!.activeChatFile!)
        : null;
      const stored = decodeStoredXuanxiang(turn?.externalRefs.xuanxiang);
      const expectedMessageId = Number(turn?.externalRefs.xuanxiangMessageId ?? 0);

      if (
        !turn
        || turn.accountId !== accountId
        || turn.channel !== "telegram"
        || turn.status !== "completed"
        || turn.revokedAt
        || turn.sessionKey !== activeSessionKey
        || String(turn.externalRefs.chatId ?? "") !== String(chatId)
        || latestTurn?.id !== turn.id
        || expectedMessageId !== callbackMessageId
        || !stored
      ) {
        await ctx.answerCallbackQuery({ text: "这个选项已失效，请使用当前会话的最新选项" });
        return;
      }

      const operationKey = swipeOperationKey(accountId, active!.activeCharacterAvatar!, active!.activeChatFile!);
      if (activeSwipeOperations.has(operationKey)) {
        await ctx.answerCallbackQuery({ text: "当前回复正在处理，请稍后再点" });
        return;
      }
      activeSwipeOperations.add(operationKey);

      try {
        let actionResult;
        try {
          actionResult = applyXuanxiangAction(stored.options, stored.state, callback.letter, callback.action);
        } catch (error) {
          await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : "无法处理这个选项" });
          return;
        }

        const updated: StoredXuanxiang = {
          ...stored,
          state: actionResult.state,
        };
        const swipeIndex = Number(turn.externalRefs.swipeIndex ?? 0);
        const swipeCount = Math.max(1, Number(turn.externalRefs.swipeCount ?? 1));
        const bySwipe = storedXuanxiangBySwipe(turn.externalRefs, swipeIndex, swipeCount);
        if (Number.isInteger(swipeIndex) && swipeIndex >= 0 && swipeIndex < bySwipe.length) {
          bySwipe[swipeIndex] = updated;
        }
        deps.repositories.turnRepository.updateTurnExternalRefs(turn.id, {
          ...turn.externalRefs,
          xuanxiang: updated,
          xuanxiangBySwipe: bySwipe,
        });
        const panel = renderXuanxiangPanel(updated.options, updated.state, String(turn.id));
        await ctx.answerCallbackQuery({ text: actionResult.notice });
        try {
          await botCtx.sender.editText(ctx, chatId, callbackMessageId, panel.text, {
            priority: "critical",
            replyMarkup: panel.keyboard ?? { inline_keyboard: [] },
          });
        } catch {
          // Persisted state remains authoritative even if Telegram cannot update an old message.
        }

        if (actionResult.selected) {
          const marker = formatXuanxiangSelection(actionResult.selected);
          const selectionMessage = await replyText(
            ctx,
            botCtx,
            `你选择了：${actionResult.selected.letter} - ${actionResult.selected.selectionText}`,
          );
          await sendConversationText(
            ctx,
            deps,
            botCtx,
            userId,
            marker,
            `xuanxiang:${turn.id}:${actionResult.selected.letter}`,
            selectionMessage.message_id,
          );
        }
      } finally {
        activeSwipeOperations.delete(operationKey);
      }
      return;
    }

    if (data.startsWith("branch:")) {
      const choice = data.slice("branch:".length).trim().toUpperCase();
      if (!/^(?:[A-Z]|\d{1,2})$/.test(choice)) {
        await ctx.answerCallbackQuery({ text: "这个选项已经失效" });
        return;
      }

      const active = deps.sessionService.getActiveSession(accountId);
      const operationKey = active?.activeCharacterAvatar && active.activeChatFile
        ? swipeOperationKey(accountId, active.activeCharacterAvatar, active.activeChatFile)
        : null;
      if (operationKey && activeSwipeOperations.has(operationKey)) {
        await ctx.answerCallbackQuery({ text: "当前回复正在处理，请稍后再点" });
        return;
      }
      if (operationKey) activeSwipeOperations.add(operationKey);

      try {
        await ctx.answerCallbackQuery({ text: `已选择 ${choice}` });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        } catch {
          // The choice can still be processed if Telegram could not remove stale buttons.
        }
        const selectionMessage = await replyText(ctx, botCtx, `你选择了：${choice}`);
        await sendConversationText(
          ctx,
          deps,
          botCtx,
          userId,
          choice,
          `branch:${ctx.callbackQuery.id}`,
          selectionMessage.message_id,
        );
      } finally {
        if (operationKey) activeSwipeOperations.delete(operationKey);
      }
      return;
    }

    if (data.startsWith("characters:")) {
      const parts = data.split(":");
      const hasSearch = parts.length >= 3;
      const search = hasSearch ? decodeCallbackToken(parts[1] ?? "") ?? "" : "";
      const page = Number(hasSearch ? parts[2] : parts[1]);
      await ctx.answerCallbackQuery();
      await replyCharacters(ctx, deps, botCtx, Number.isFinite(page) ? page : 0, search);
      return;
    }

    if (data.startsWith("char:")) {
      const parts = data.split(":");
      const hasSearch = parts.length >= 4;
      const search = hasSearch ? decodeCallbackToken(parts[1] ?? "") ?? "" : "";
      const page = Number(hasSearch ? parts[2] : parts[1]);
      const index = Number(hasSearch ? parts[3] : parts[2]);
      const allCharacters = await getCharacters(deps);
      const normalizedSearch = search.trim().toLocaleLowerCase();
      const characters = normalizedSearch
        ? allCharacters.filter((character) => `${character.name} ${character.avatar}`.toLocaleLowerCase().includes(normalizedSearch))
        : allCharacters;
      const character = characters[(Number.isFinite(page) ? page : 0) * botCtx.config.pageSize + index];
      await ctx.answerCallbackQuery();

      if (!character) {
        await replyText(ctx, botCtx, "角色选择已失效，请重新执行 /characters。");
        return;
      }

      deps.sessionService.setActiveCharacter(accountId, character.avatar, character.name);
      await replyCharacterMode(ctx, botCtx, character.name);
      return;
    }

    if (data === "char-mode:history") {
      await ctx.answerCallbackQuery();
      await replyHistory(ctx, deps, accountId, botCtx, 0);
      return;
    }

    if (data === "char-mode:new") {
      await ctx.answerCallbackQuery();
      await replyGreetingSelection(ctx, deps, botCtx, accountId, 0);
      return;
    }

    if (data.startsWith("greet:")) {
      const [, action, indexToken] = data.split(":");
      const currentIndex = Number(indexToken ?? 0);
      if (!Number.isInteger(currentIndex) || currentIndex < 0) {
        await ctx.answerCallbackQuery({ text: "开场白选择已失效" });
        return;
      }
      const greetingChatId = ctx.chat?.id;
      const greetingMenu = greetingChatId ? greetingMenus.get(`${accountId}:${greetingChatId}`) : undefined;
      const activeGreetingState = deps.sessionService.getActiveSession(accountId);
      if (!greetingChatId) {
        await ctx.answerCallbackQuery({ text: "开场白选择已失效" });
        return;
      }
      if (
        !greetingMenu
        || !activeGreetingState?.activeCharacterAvatar
        || greetingMenu.avatar !== activeGreetingState.activeCharacterAvatar
        || greetingMenu.index !== currentIndex
        || Number(ctx.callbackQuery.message?.message_id ?? 0) !== Number(greetingMenu.messageIds.at(-1) ?? 0)
      ) {
        await ctx.answerCallbackQuery({ text: "开场白选择已失效，请重新使用 /new" });
        return;
      }
      if (action === "p" || action === "n") {
        const targetIndex = action === "p" ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= greetingMenu.greetings.length) {
          await ctx.answerCallbackQuery({ text: "已经没有更多开场白了" });
          return;
        }
        await ctx.answerCallbackQuery();
        await replyGreetingSelection(ctx, deps, botCtx, accountId, targetIndex);
        return;
      }
      if (action === "i") {
        await ctx.answerCallbackQuery({ text: `第 ${currentIndex + 1} / ${greetingMenu.greetings.length} 条开场白` });
        return;
      }
      if (action === "u") {
        await ctx.answerCallbackQuery({ text: "正在创建新会话" });
        greetingMenus.delete(`${accountId}:${greetingChatId}`);
        await deleteMessagesBestEffort(ctx, botCtx, greetingChatId, greetingMenu.messageIds);
        await createNewChat(ctx, deps, botCtx, accountId, currentIndex);
        return;
      }
      await replyText(ctx, botCtx, "开场白选择已失效，请重新使用 /new。", { priority: "critical" });
      return;
    }

    if (data.startsWith("history:")) {
      await ctx.answerCallbackQuery();
      await replyHistory(ctx, deps, accountId, botCtx, Number(data.split(":")[1] ?? 0));
      return;
    }

    if (data.startsWith("open:")) {
      const [, pageToken, indexToken] = data.split(":");
      const result = await getCurrentCharacterChats(accountId, deps);
      await ctx.answerCallbackQuery();

      if (!result) {
        await replyText(ctx, botCtx, "当前角色状态不存在，请重新使用 /characters。");
        return;
      }

      const chat = result.chats[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
      if (!chat) {
        await replyText(ctx, botCtx, "会话选择已失效，请重新使用 /history。");
        return;
      }

      deps.sessionService.setActiveSession(accountId, result.avatar, result.characterName, chat.fileId);
      const latestRecord = await deps.stClient.getLatestDialogueRecord(result.avatar, chat.fileId);
      await replyLongText(ctx, botCtx, renderLatestDialogue(result.characterName, chat.fileId, latestRecord));
      return;
    }

    if (data.startsWith("recent:")) {
      const index = Number(data.split(":")[1] ?? 0);
      const recentSessions = deps.sessionService.listRecentSessions(accountId, botCtx.config.pageSize);
      const recent = recentSessions[index];
      await ctx.answerCallbackQuery();

      if (!recent) {
        await replyText(ctx, botCtx, "最近会话记录已失效，请重新执行 /recent。");
        return;
      }

      deps.sessionService.setActiveSession(accountId, recent.characterAvatar, recent.characterName, recent.chatFile);
      const latestRecord = await deps.stClient.getLatestDialogueRecord(recent.characterAvatar, recent.chatFile);
      await replyLongText(ctx, botCtx, renderLatestDialogue(recent.characterName, recent.chatFile, latestRecord));
      return;
    }

    if (
      data.startsWith("gapi:")
      || data.startsWith("gpreset:")
      || data.startsWith("gprompt:")
      || data.startsWith("gsettings:")
    ) {
      if (!await requireGlobalSettingsAdmin(ctx, deps, botCtx, accountId)) {
        await ctx.answerCallbackQuery({ text: "需要 SillyTavern 管理员权限" });
        return;
      }
      try {
        if (data.startsWith("gapi:p:")) {
          const page = Number(data.split(":")[2] ?? 0);
          await ctx.answerCallbackQuery();
          const snapshot = await getGlobalSettings(accountId, deps);
          await editGlobalSettingsMessage(ctx, botCtx, renderGlobalProfilePage(snapshot, page, botCtx.config.pageSize));
          return;
        }
        if (data.startsWith("gapi:s:")) {
          const [, , pageToken, indexToken] = data.split(":");
          const page = Number(pageToken ?? 0);
          const snapshot = await getGlobalSettings(accountId, deps);
          const name = snapshot.profiles[page * botCtx.config.pageSize + Number(indexToken)];
          if (!name) {
            await ctx.answerCallbackQuery({ text: "连接配置列表已经变化" });
            return;
          }
          if (name === snapshot.currentProfile) {
            await ctx.answerCallbackQuery({ text: "已经是当前全局连接配置" });
            return;
          }
          await ctx.answerCallbackQuery({ text: "正在切换全局连接配置" });
          const updated = await deps.webRelayService.executeControl({
            accountId,
            operation: "settings_select_profile",
            payload: { name },
          });
          deps.modelService.clearModelSelection(accountId);
          const rendered = renderGlobalProfilePage(updated, page, botCtx.config.pageSize);
          rendered.text = `✅ 已全局切换连接配置：${name}\n\n${rendered.text}`;
          await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gpreset:p:")) {
          const page = Number(data.split(":")[2] ?? 0);
          await ctx.answerCallbackQuery();
          const snapshot = await getGlobalSettings(accountId, deps);
          await editGlobalSettingsMessage(ctx, botCtx, renderGlobalPresetPage(snapshot, page, botCtx.config.pageSize));
          return;
        }
        if (data.startsWith("gpreset:s:")) {
          const [, , pageToken, indexToken] = data.split(":");
          const page = Number(pageToken ?? 0);
          const snapshot = await getGlobalSettings(accountId, deps);
          const name = snapshot.presets[page * botCtx.config.pageSize + Number(indexToken)];
          if (!name) {
            await ctx.answerCallbackQuery({ text: "预设列表已经变化" });
            return;
          }
          if (name === snapshot.currentPreset) {
            await ctx.answerCallbackQuery({ text: "已经是当前全局聊天预设" });
            return;
          }
          await ctx.answerCallbackQuery({ text: "正在切换全局聊天预设" });
          const updated = await deps.webRelayService.executeControl({
            accountId,
            operation: "settings_select_preset",
            payload: { name },
          });
          const rendered = renderGlobalPresetPage(updated, page, botCtx.config.pageSize);
          rendered.text = `✅ 已全局切换聊天预设：${name}\n\n${rendered.text}`;
          await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gprompt:sections:")) {
          const page = Number(data.split(":")[2] ?? 0);
          await ctx.answerCallbackQuery();
          const snapshot = await getGlobalSettings(accountId, deps);
          await editGlobalSettingsMessage(ctx, botCtx, renderPromptSections(snapshot, page, botCtx.config.pageSize));
          return;
        }
        if (data.startsWith("gprompt:section:")) {
          const [, , sectionToken, pageToken] = data.split(":");
          const snapshot = await getGlobalSettings(accountId, deps);
          const rendered = renderPromptGroups(
            snapshot,
            Number(sectionToken),
            Number(pageToken),
            botCtx.config.pageSize,
          );
          await ctx.answerCallbackQuery(rendered ? undefined : { text: "预设分类已经变化" });
          if (rendered) await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gprompt:group:")) {
          const [, , sectionToken, groupToken, pageToken] = data.split(":");
          const snapshot = await getGlobalSettings(accountId, deps);
          const rendered = renderPromptOptions(
            snapshot,
            Number(sectionToken),
            Number(groupToken),
            Number(pageToken),
            botCtx.config.pageSize,
          );
          await ctx.answerCallbackQuery(rendered ? undefined : { text: "预设分组已经变化" });
          if (rendered) await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gprompt:q:")) {
          const [, , sectionToken, groupToken, pageToken, optionToken] = data.split(":");
          const snapshot = await getGlobalSettings(accountId, deps);
          const rendered = renderPromptChangePreview(
            snapshot,
            Number(sectionToken),
            Number(groupToken),
            Number(pageToken),
            Number(optionToken),
          );
          await ctx.answerCallbackQuery(rendered ? undefined : { text: "预设选项已经变化" });
          if (rendered) await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gprompt:a:")) {
          const [, , sectionToken, groupToken, pageToken, optionToken, enabledToken] = data.split(":");
          const sectionIndex = Number(sectionToken);
          const groupIndex = Number(groupToken);
          const page = Number(pageToken);
          const optionIndex = Number(optionToken);
          const enabled = enabledToken === "1";
          const snapshot = await getGlobalSettings(accountId, deps);
          const entry = groupGlobalPrompts(snapshot.prompts)[sectionIndex]?.groups[groupIndex]?.entries[optionIndex];
          if (!entry) {
            await ctx.answerCallbackQuery({ text: "预设选项已经变化" });
            return;
          }
          await ctx.answerCallbackQuery({ text: enabled ? "正在全局启用" : "正在全局禁用" });
          const updated = entry.enabled === enabled
            ? snapshot
            : await deps.webRelayService.executeControl({
              accountId,
              operation: "settings_set_prompt_entries",
              payload: { identifiers: [entry.identifier], enabled },
            });
          const rendered = renderPromptOptions(updated, sectionIndex, groupIndex, page, botCtx.config.pageSize);
          if (!rendered) throw new AppError("GLOBAL_PROMPT_STALE", "修改后预设结构发生变化，请重新执行 /preset", 409);
          rendered.text = `✅ 已${enabled ? "启用" : "禁用"}：${entry.name}\n\n${rendered.text}`;
          await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gprompt:bq:")) {
          const [, , sectionToken, groupToken, pageToken, enabledToken] = data.split(":");
          const snapshot = await getGlobalSettings(accountId, deps);
          const rendered = renderPromptBulkPreview(
            snapshot,
            Number(sectionToken),
            Number(groupToken),
            Number(pageToken),
            enabledToken === "1",
          );
          await ctx.answerCallbackQuery(rendered ? undefined : { text: "预设分组已经变化" });
          if (rendered) await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data.startsWith("gprompt:ba:")) {
          const [, , sectionToken, groupToken, pageToken, enabledToken] = data.split(":");
          const sectionIndex = Number(sectionToken);
          const groupIndex = Number(groupToken);
          const page = Number(pageToken);
          const enabled = enabledToken === "1";
          const snapshot = await getGlobalSettings(accountId, deps);
          const group = groupGlobalPrompts(snapshot.prompts)[sectionIndex]?.groups[groupIndex];
          if (!group) {
            await ctx.answerCallbackQuery({ text: "预设分组已经变化" });
            return;
          }
          const identifiers = group.entries.filter((entry) => entry.enabled !== enabled).map((entry) => entry.identifier);
          await ctx.answerCallbackQuery({ text: enabled ? "正在全部启用" : "正在全部禁用" });
          const updated = identifiers.length === 0
            ? snapshot
            : await deps.webRelayService.executeControl({
              accountId,
              operation: "settings_set_prompt_entries",
              payload: { identifiers, enabled },
            });
          const rendered = renderPromptOptions(updated, sectionIndex, groupIndex, page, botCtx.config.pageSize);
          if (!rendered) throw new AppError("GLOBAL_PROMPT_STALE", "修改后预设结构发生变化，请重新执行 /preset", 409);
          rendered.text = `✅ 已${enabled ? "全部启用" : "全部禁用"}：${group.name}\n\n${rendered.text}`;
          await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
        if (data === "gsettings:undo") {
          await ctx.answerCallbackQuery({ text: "正在撤销上次全局修改" });
          const updated = await deps.webRelayService.executeControl({ accountId, operation: "settings_undo" });
          deps.modelService.clearModelSelection(accountId);
          const rendered = renderGlobalPresetPage(updated, 0, botCtx.config.pageSize);
          rendered.text = `✅ 已撤销上次全局设置修改。\n\n${rendered.text}`;
          await editGlobalSettingsMessage(ctx, botCtx, rendered);
          return;
        }
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
        return;
      }
    }

    const isGlobalModelCallback = data.startsWith("providers:")
      || data.startsWith("provider:")
      || data.startsWith("pmodels:")
      || data.startsWith("pmodel:")
      || data.startsWith("models:")
      || data.startsWith("model:");
    if (isGlobalModelCallback && !await requireGlobalSettingsAdmin(ctx, deps, botCtx, accountId)) {
      await ctx.answerCallbackQuery({ text: "需要 SillyTavern 管理员权限" });
      return;
    }

    if (data.startsWith("providers:")) {
      await ctx.answerCallbackQuery();
      try {
        await replyModels(ctx, deps, accountId, botCtx, Number(data.split(":")[1] ?? 0));
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data.startsWith("provider:")) {
      const providerIdx = Number(data.split(":")[1] ?? 0);
      await ctx.answerCallbackQuery();
      try {
        await replyProviderModels(ctx, deps, accountId, botCtx, providerIdx, 0);
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data.startsWith("pmodels:")) {
      const [, providerToken, pageToken] = data.split(":");
      await ctx.answerCallbackQuery();
      try {
        await replyProviderModels(ctx, deps, accountId, botCtx, Number(providerToken ?? 0), Number(pageToken ?? 0));
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data.startsWith("pmodel:")) {
      try {
        const [, providerToken, pageToken, indexToken] = data.split(":");
        const providerIdx = Number(providerToken ?? 0);
        const { models, currentModel } = await getModels(accountId, deps);
        const groups = groupModelsByProvider(models);
        const group = groups[providerIdx];
        if (!group) {
          await ctx.answerCallbackQuery({ text: "供应商选择已失效" });
          return;
        }

        const model = group.models[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
        if (!model) {
          await ctx.answerCallbackQuery({ text: "模型选择已失效" });
          return;
        }

        if (model.id.toLocaleLowerCase() === currentModel.toLocaleLowerCase()) {
          await ctx.answerCallbackQuery({ text: "已经是当前酒馆全局模型" });
          return;
        }

        await ctx.answerCallbackQuery({ text: "正在切换酒馆全局模型" });
        await deps.webRelayService.executeControl({
          accountId,
          operation: "settings_select_model",
          payload: { name: model.id },
        });
        deps.modelService.clearModelSelection(accountId);
        await replyText(ctx, botCtx, `✅ 已全局切换模型：${model.id}\n该模型对所有角色和聊天生效。`);
        await replyProviderModels(ctx, deps, accountId, botCtx, providerIdx, Number(pageToken));
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data.startsWith("models:")) {
      await ctx.answerCallbackQuery();
      try {
        await replyModels(ctx, deps, accountId, botCtx, Number(data.split(":")[1] ?? 0));
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data === "model:reset") {
      deps.modelService.clearModelSelection(accountId);
      await ctx.answerCallbackQuery({ text: "已清除旧版 Telegram 模型覆盖" });
      try {
        await replyModels(ctx, deps, accountId, botCtx, 0);
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data.startsWith("model:")) {
      try {
        const [, pageToken, indexToken] = data.split(":");
        const { models, currentModel } = await getModels(accountId, deps);
        const model = models[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
        if (!model) {
          await ctx.answerCallbackQuery({ text: "模型选择已失效" });
          return;
        }

        if (model.id.toLocaleLowerCase() === currentModel.toLocaleLowerCase()) {
          await ctx.answerCallbackQuery({ text: "已经是当前酒馆全局模型" });
          return;
        }

        await ctx.answerCallbackQuery({ text: "正在切换酒馆全局模型" });
        await deps.webRelayService.executeControl({
          accountId,
          operation: "settings_select_model",
          payload: { name: model.id },
        });
        deps.modelService.clearModelSelection(accountId);
        await replyText(ctx, botCtx, `✅ 已全局切换模型：${model.id}\n该模型对所有角色和聊天生效。`);
        await replyModels(ctx, deps, accountId, botCtx, Number(pageToken));
      } catch (error) {
        await reportGlobalSettingsError(ctx, botCtx, error);
      }
      return;
    }

    if (data.startsWith("cproviders:")) {
      await ctx.answerCallbackQuery();
      await replyCompressionModels(ctx, deps, accountId, botCtx, Number(data.split(":")[1] ?? 0));
      return;
    }

    if (data.startsWith("cprovider:")) {
      const providerIdx = Number(data.split(":")[1] ?? 0);
      await ctx.answerCallbackQuery();
      await replyCompressionProviderModels(ctx, deps, accountId, botCtx, providerIdx, 0);
      return;
    }

    if (data.startsWith("cpmodels:")) {
      const [, providerToken, pageToken] = data.split(":");
      await ctx.answerCallbackQuery();
      await replyCompressionProviderModels(ctx, deps, accountId, botCtx, Number(providerToken ?? 0), Number(pageToken ?? 0));
      return;
    }

    if (data.startsWith("cpmodel:")) {
      const [, providerToken, pageToken, indexToken] = data.split(":");
      const providerIdx = Number(providerToken ?? 0);
      const { models } = await getCompressionModels(accountId, deps);
      const groups = groupModelsByProvider(models);
      const group = groups[providerIdx];
      await ctx.answerCallbackQuery();

      if (!group) {
        await replyText(ctx, botCtx, "供应商选择已失效，请重新执行 /cmodel。");
        return;
      }

      const model = group.models[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
      if (!model) {
        await replyText(ctx, botCtx, "模型选择已失效，请重新执行 /cmodel。");
        return;
      }

      deps.modelService.selectCompressionModel(accountId, model.id);
      await replyText(ctx, botCtx, `已切换压缩模型：${model.id}`);
      await replyCompressionProviderModels(ctx, deps, accountId, botCtx, providerIdx, Number(pageToken));
      return;
    }

    if (data === "cmodel:reset") {
      deps.modelService.clearCompressionModelSelection(accountId);
      await ctx.answerCallbackQuery({ text: "已恢复压缩模型为聊天模型" });
      await replyCompressionModels(ctx, deps, accountId, botCtx, 0);
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on("edited_message:text", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) return;
    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state?.chatId) {
      await replyText(ctx, botCtx, "未同步这次编辑：当前没有绑定角色和会话。");
      return;
    }

    const latestTurn = getLatestTelegramTurn(
      deps,
      accountId,
      state.chatId,
      state.activeCharacterAvatar!,
      state.activeChatFile!,
    );
    const editedMessageId = ctx.editedMessage.message_id;
    if (!latestTurn || Number(latestTurn.externalRefs.userMessageId ?? 0) !== editedMessageId) {
      await replyText(ctx, botCtx, "未同步这次编辑：只支持编辑当前会话最新一轮的用户消息。");
      return;
    }
    if (latestTurn.status !== "completed") {
      await replyText(ctx, botCtx, "当前回复仍在生成，请生成完成后再编辑最新消息。");
      return;
    }

    const operationKey = swipeOperationKey(accountId, state.activeCharacterAvatar!, state.activeChatFile!);
    if (activeSwipeOperations.has(operationKey)) {
      await replyText(ctx, botCtx, "当前回复正在处理，请完成后再编辑最新消息。");
      return;
    }
    activeSwipeOperations.add(operationKey);

    try {
      const result = await deps.chatEditService.editLatestUserMessage({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
        text: ctx.editedMessage.text,
      });
      deps.repositories.turnRepository.updateTurnExternalRefs(latestTurn.id, {
        ...latestTurn.externalRefs,
        editedUserMessageAt: new Date((ctx.editedMessage.edit_date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        swipeIndex: result.swipeIndex,
        swipeCount: result.swipeCount || Number(latestTurn.externalRefs.swipeCount ?? 1),
      });
      await replyText(
        ctx,
        botCtx,
        "✏️ 已同步修改到酒馆。当前回复暂时保留；请点击“重新生成”或“生成备选”。",
      );
    } catch (error) {
      await replyText(ctx, botCtx, `同步编辑失败：${error instanceof Error ? error.message : String(error)}`, { priority: "critical" });
    } finally {
      activeSwipeOperations.delete(operationKey);
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      return;
    }

    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const worldBookState = getWorldBookMenu(accountId, ctx.chat?.id, userId);
    const repliedMessageId = Number(ctx.message.reply_to_message?.message_id ?? 0);
    if (worldBookState?.editPromptMessageId && repliedMessageId === worldBookState.editPromptMessageId) {
      const entry = selectedWorldBookEntry(worldBookState);
      if (!worldBookState.currentBook || !entry) {
        worldBookMenus.delete(worldBookMenuKey(accountId, worldBookState.chatId, userId));
        worldBookState.cleanup.resume();
        await replyText(ctx, botCtx, "世界书编辑状态已失效，请重新使用 /worldbook。", { priority: "critical" });
        return;
      }
      const nextContent = ctx.message.text;
      if (nextContent === entry.content) {
        worldBookState.editPromptMessageId = null;
        await replyWorldBookText(ctx, botCtx, worldBookState, "新正文与原正文相同，没有需要保存的修改。");
        await showWorldBookEntry(ctx, botCtx, worldBookState);
        return;
      }
      worldBookState.pending = {
        entryRef: entry.ref,
        expectedRevision: worldBookState.currentBook.revision,
        content: nextContent,
      };
      worldBookState.expiresAt = Date.now() + WORLD_BOOK_EDIT_TTL_MS;
      worldBookState.editPromptMessageId = null;
      const rendered = renderWorldBookChangePreview({
        bookName: worldBookState.currentBook.name,
        entry,
        nextContent,
      });
      const message = await replyWorldBookText(ctx, botCtx, worldBookState, rendered.text, { reply_markup: rendered.keyboard });
      worldBookState.messageId = message.message_id;
      return;
    }

    const state = deps.sessionService.getActiveSession(accountId);
    let operationKey: string | null = null;
    if (state?.activeCharacterAvatar && state.activeChatFile) {
      operationKey = swipeOperationKey(accountId, state.activeCharacterAvatar, state.activeChatFile);
      if (activeSwipeOperations.has(operationKey)) {
        await replyText(ctx, botCtx, "当前回复正在处理，请完成后再发送新消息。", { priority: "critical" });
        return;
      }
      activeSwipeOperations.add(operationKey);
    }

    try {
      await sendConversationText(
        ctx,
        deps,
        botCtx,
        userId,
        ctx.message.text,
        String(ctx.message.message_id),
        ctx.message.message_id,
      );
    } finally {
      if (operationKey) activeSwipeOperations.delete(operationKey);
    }
  });
}
