import { Bot, Context } from "grammy";
import type { AppServices } from "../../plugin/build-services";
import type { CharacterSummary, ChatSearchResult, ModelSummary } from "../../core/models/index";
import { AppError } from "../../shared/errors/app-error";
import { buildSessionKey, createRequestId } from "../../shared/utils/ids";
import {
  COMPRESSION_MODEL_CALLBACK_PREFIX,
  groupModelsByProvider,
  renderCharactersPage,
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
  renderUndoResult,
  splitTelegramText,
} from "./render";
import { StreamRenderer } from "./stream-renderer";
import {
  applyXuanxiangAction,
  createStoredXuanxiang,
  decodeStoredXuanxiang,
  decodeXuanxiangCallback,
  formatXuanxiangSelection,
  renderXuanxiangPanel,
  type StoredXuanxiang,
} from "./xuanxiang";

type BotContext = Context;

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

async function getCharacters(deps: AppServices): Promise<CharacterSummary[]> {
  return deps.characterService.listCharacters();
}

async function getModels(accountId: string, deps: AppServices): Promise<{ models: ModelSummary[]; currentModel: string }> {
  const result = await deps.modelService.listAvailableModels(accountId);
  return {
    models: result.items,
    currentModel: result.overrideModel ?? result.currentModel,
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

async function replyCharacters(ctx: BotContext, deps: AppServices, botCtx: BotInstanceContext, page = 0): Promise<void> {
  const characters = await getCharacters(deps);
  const rendered = renderCharactersPage(characters, page, botCtx.config.pageSize);
  await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
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

function createStreamRenderer(
  ctx: BotContext,
  deps: AppServices,
  botCtx: BotInstanceContext,
  initialMessageId: number,
  xuanxiangCallbackId: number | null = null,
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
  return deps.repositories.turnRepository.getLatestActiveTurnRecord({
    accountId,
    channel: "telegram",
    sessionKey: buildSessionKey(avatar, chatFile),
    externalRefMatches: {
      chatId,
    },
  });
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
          xuanxiangMessageId: xuanxiang ? streamRenderer.getMessageIds().at(-1) ?? null : null,
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

    await replyCharacters(ctx, deps, botCtx, 0);
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

    const rendered = renderRecentSessionsPage(recentSessions);
    await replyText(ctx, botCtx, rendered.text, { reply_markup: rendered.keyboard });
  });

  bot.command("model", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await replyModels(ctx, deps, getAccountId(userId, deps, botCtx), botCtx, 0);
  });

  bot.command("cmodel", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await replyCompressionModels(ctx, deps, getAccountId(userId, deps, botCtx), botCtx, 0);
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

    const accountId = getAccountId(userId, deps, botCtx);
    const state = getActiveSessionMessage(ctx.chat?.id, accountId, deps);
    if (!state) {
      await replyText(ctx, botCtx, "当前没有绑定角色和会话。请先使用 /chars 选择角色和历史聊天。");
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
      operation: "telegram_undo",
      status: "started",
      externalRefs: state.chatId ? { chatId: state.chatId } : {},
    });

    try {
      const result = await deps.chatEditService.deleteLastTurn({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
      });

      if (state.chatId) {
        const latestTurn = getLatestTelegramTurn(deps, accountId, state.chatId, state.activeCharacterAvatar!, state.activeChatFile!);
        if (latestTurn) {
          deps.repositories.turnRepository.markTurnRevoked(latestTurn.id);
          deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
            status: "completed",
            errorMessage: null,
            externalRefs: {
              chatId: state.chatId,
              revokedTurnRecordId: latestTurn.id,
              removedUserMessageId: result.removed.userMessage?.messageId ?? null,
              removedAssistantMessageId: result.removed.assistantMessage?.messageId ?? null,
              latestMessageId: result.latestRecord?.messageId ?? null,
              latestTurnId: result.latestRecord?.turnId ?? null,
            },
          });
        } else {
          deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
            status: "completed",
            errorMessage: null,
            externalRefs: {
              chatId: state.chatId,
              removedUserMessageId: result.removed.userMessage?.messageId ?? null,
              removedAssistantMessageId: result.removed.assistantMessage?.messageId ?? null,
              latestMessageId: result.latestRecord?.messageId ?? null,
              latestTurnId: result.latestRecord?.turnId ?? null,
            },
          });
        }
      } else {
        deps.repositories.turnRepository.updateTurnRecord(turnRecordId, {
          status: "completed",
          errorMessage: null,
          externalRefs: {
            removedUserMessageId: result.removed.userMessage?.messageId ?? null,
            removedAssistantMessageId: result.removed.assistantMessage?.messageId ?? null,
            latestMessageId: result.latestRecord?.messageId ?? null,
            latestTurnId: result.latestRecord?.turnId ?? null,
          },
        });
      }

      await replyLongText(ctx, botCtx, renderUndoResult(result.removed));
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
    const requestId = createRequestId();
    const traceId = requestId;

    const existingBotMessageIds = Array.isArray(latestTurn?.externalRefs.botMessageIds)
      ? (latestTurn!.externalRefs.botMessageIds as unknown[]).map((item) => Number(item)).filter((item) => Number.isInteger(item))
      : [];

    try {
      if (latestTurn) {
        deps.repositories.turnRepository.updateTurnRecord(latestTurn.id, {
          requestId,
          traceId,
          operation: "telegram_redo_stream",
          status: "started",
          errorMessage: null,
        });
      }

      let placeholderMessageId: number;
      if (existingBotMessageIds.length > 0 && ctx.chat?.id) {
        const chatId = ctx.chat.id;
        await botCtx.sender.editText(ctx, chatId, existingBotMessageIds[0], "正在重回复中", { priority: "critical" });
        for (const extraId of existingBotMessageIds.slice(1).reverse()) {
          try {
            await botCtx.sender.deleteMessage(ctx, chatId, extraId, "normal");
          } catch {
            // ignore cleanup failures
          }
        }
        placeholderMessageId = existingBotMessageIds[0];
      } else {
        const placeholder = await replyText(ctx, botCtx, "正在重回复中");
        placeholderMessageId = placeholder.message_id;
      }

      const streamRenderer = createStreamRenderer(ctx, deps, botCtx, placeholderMessageId, latestTurn?.id ?? null);
      const result = await deps.chatEditService.regenerateLastReply({
        accountId,
        avatar: state.activeCharacterAvatar!,
        characterName: state.activeCharacterName!,
        chatFile: state.activeChatFile!,
        modelOverride: state.activeModelOverride,
        onProgress: async (event) => {
          if (event.type === "delta") {
            await streamRenderer.onProgress(event.fullText);
          }
        },
      });

      const xuanxiang = createStoredXuanxiang(result.replyText);
      if (latestTurn) {
        deps.repositories.turnRepository.updateTurnExternalRefs(latestTurn.id, {
          ...latestTurn.externalRefs,
          xuanxiang,
        });
      }
      await streamRenderer.onDone(result.replyText, result.mvuStatus);

      if (latestTurn) {
        deps.repositories.turnRepository.updateTurnRecord(latestTurn.id, {
          requestId,
          traceId,
          operation: "telegram_redo_stream",
          status: "completed",
          errorMessage: null,
          externalRefs: {
            ...latestTurn.externalRefs,
            botMessageIds: streamRenderer.getMessageIds(),
            latestMessageId: result.latestRecord?.messageId ?? null,
            latestTurnId: result.latestRecord?.turnId ?? null,
            xuanxiang,
            xuanxiangMessageId: xuanxiang ? streamRenderer.getMessageIds().at(-1) ?? null : null,
          },
        });
      }
    } catch (error) {
      if (latestTurn) {
        deps.repositories.turnRepository.updateTurnRecord(latestTurn.id, {
          requestId,
          traceId,
          operation: "telegram_redo_stream",
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      await replyText(ctx, botCtx, `重生成失败：${message}`, { priority: "critical" });
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

    const created = await deps.characterService.createChatFromCharacter(state.activeCharacterAvatar);
    deps.sessionService.setActiveSession(accountId, created.avatar, created.characterName, created.fileId);
    const latestRecord = await deps.stClient.getLatestDialogueRecord(created.avatar, created.fileId);
    await replyLongText(ctx, botCtx, renderLatestDialogue(created.characterName, created.fileId, latestRecord));
  });

  bot.on("callback_query:data", async (ctx) => {
    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const accountId = getAccountId(userId, deps, botCtx);
    const data = ctx.callbackQuery.data;

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
      deps.repositories.turnRepository.updateTurnExternalRefs(turn.id, {
        ...turn.externalRefs,
        xuanxiang: updated,
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
      return;
    }

    if (data.startsWith("branch:")) {
      const choice = data.slice("branch:".length).trim().toUpperCase();
      if (!/^(?:[A-Z]|\d{1,2})$/.test(choice)) {
        await ctx.answerCallbackQuery({ text: "这个选项已经失效" });
        return;
      }

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
      return;
    }

    if (data.startsWith("characters:")) {
      await ctx.answerCallbackQuery();
      await replyCharacters(ctx, deps, botCtx, Number(data.split(":")[1] ?? 0));
      return;
    }

    if (data.startsWith("char:")) {
      const [, pageToken, indexToken] = data.split(":");
      const characters = await getCharacters(deps);
      const character = characters[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
      await ctx.answerCallbackQuery();

      if (!character) {
        await replyText(ctx, botCtx, "角色选择已失效，请重新执行 /characters。");
        return;
      }

      deps.sessionService.setActiveCharacter(accountId, character.avatar, character.name);
      await replyText(ctx, botCtx, `已选择角色：${character.name}`);
      await replyHistory(ctx, deps, accountId, botCtx, 0);
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

    if (data.startsWith("providers:")) {
      await ctx.answerCallbackQuery();
      await replyModels(ctx, deps, accountId, botCtx, Number(data.split(":")[1] ?? 0));
      return;
    }

    if (data.startsWith("provider:")) {
      const providerIdx = Number(data.split(":")[1] ?? 0);
      await ctx.answerCallbackQuery();
      await replyProviderModels(ctx, deps, accountId, botCtx, providerIdx, 0);
      return;
    }

    if (data.startsWith("pmodels:")) {
      const [, providerToken, pageToken] = data.split(":");
      await ctx.answerCallbackQuery();
      await replyProviderModels(ctx, deps, accountId, botCtx, Number(providerToken ?? 0), Number(pageToken ?? 0));
      return;
    }

    if (data.startsWith("pmodel:")) {
      const [, providerToken, pageToken, indexToken] = data.split(":");
      const providerIdx = Number(providerToken ?? 0);
      const { models } = await getModels(accountId, deps);
      const groups = groupModelsByProvider(models);
      const group = groups[providerIdx];
      await ctx.answerCallbackQuery();

      if (!group) {
        await replyText(ctx, botCtx, "供应商选择已失效，请重新执行 /model。");
        return;
      }

      const model = group.models[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
      if (!model) {
        await replyText(ctx, botCtx, "模型选择已失效，请重新执行 /model。");
        return;
      }

      deps.modelService.selectModel(accountId, model.id);
      await replyText(ctx, botCtx, `已切换模型：${model.id}`);
      await replyProviderModels(ctx, deps, accountId, botCtx, providerIdx, Number(pageToken));
      return;
    }

    if (data.startsWith("models:")) {
      await ctx.answerCallbackQuery();
      await replyModels(ctx, deps, accountId, botCtx, Number(data.split(":")[1] ?? 0));
      return;
    }

    if (data === "model:reset") {
      deps.modelService.clearModelSelection(accountId);
      await ctx.answerCallbackQuery({ text: "已恢复为 ST 默认模型" });
      await replyModels(ctx, deps, accountId, botCtx, 0);
      return;
    }

    if (data.startsWith("model:")) {
      const [, pageToken, indexToken] = data.split(":");
      const { models } = await getModels(accountId, deps);
      const model = models[Number(pageToken) * botCtx.config.pageSize + Number(indexToken)];
      await ctx.answerCallbackQuery();

      if (!model) {
        await replyText(ctx, botCtx, "模型选择已失效，请重新执行 /model。");
        return;
      }

      deps.modelService.selectModel(accountId, model.id);
      await replyText(ctx, botCtx, `已切换模型：${model.id}`);
      await replyModels(ctx, deps, accountId, botCtx, Number(pageToken));
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

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      return;
    }

    const userId = await requireAuthorized(ctx, deps, botCtx);
    if (!userId) {
      return;
    }

    await sendConversationText(
      ctx,
      deps,
      botCtx,
      userId,
      ctx.message.text,
      String(ctx.message.message_id),
      ctx.message.message_id,
    );
  });
}
