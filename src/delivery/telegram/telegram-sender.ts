import { GrammyError, type Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import { TelegramChatQueue } from "./telegram-chat-queue";

export type TelegramPriority = "critical" | "normal" | "ephemeral";

type BotContext = Context;

interface SendTextOptions {
  replyMarkup?: unknown;
  entities?: MessageEntity[];
  priority?: TelegramPriority;
}

interface EditTextOptions {
  replyMarkup?: unknown;
  entities?: MessageEntity[];
  priority?: TelegramPriority;
}

interface TelegramSenderOptions {
  enableOutboundLogs?: boolean;
}

export class TelegramSender {
  private readonly enableOutboundLogs: boolean;

  public constructor(
    private readonly queue: TelegramChatQueue,
    options: TelegramSenderOptions = {},
  ) {
    this.enableOutboundLogs = options.enableOutboundLogs ?? true;
  }

  public isDegraded(chatId: string | number): boolean {
    return this.queue.isDegraded(chatId);
  }

  public markRoundCompleted(chatId: string | number): void {
    this.queue.markRoundCompleted(chatId);
  }

  public async sendText(ctx: BotContext, chatId: string | number, text: string, options: SendTextOptions = {}): Promise<{ message_id: number }> {
    return this.run(chatId, "send", options.priority ?? "normal", text.length, undefined, async () => {
      const message = await ctx.api.sendMessage(Number(chatId), text, {
        entities: options.entities,
        reply_markup: options.replyMarkup as never,
      });
      return { message_id: message.message_id };
    });
  }

  public async reply(ctx: BotContext, text: string, options: SendTextOptions = {}): Promise<{ message_id: number }> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      throw new Error("Telegram chat id missing");
    }

    return this.sendText(ctx, chatId, text, options);
  }

  public async editText(ctx: BotContext, chatId: string | number, messageId: number, text: string, options: EditTextOptions = {}): Promise<void> {
    await this.run(chatId, "edit", options.priority ?? "normal", text.length, messageId, async () => {
      try {
        await ctx.api.editMessageText(Number(chatId), messageId, text, {
          entities: options.entities,
          reply_markup: options.replyMarkup as never,
        });
      } catch (error) {
        if (this.isIgnorableEditError(error)) {
          return;
        }
        throw error;
      }
    });
  }

  public async deleteMessage(ctx: BotContext, chatId: string | number, messageId: number, priority: TelegramPriority = "normal"): Promise<void> {
    await this.run(chatId, "delete", priority, 0, messageId, async () => {
      try {
        await ctx.api.deleteMessage(Number(chatId), messageId);
      } catch (error) {
        if (this.isIgnorableDeleteError(error)) {
          return;
        }
        throw error;
      }
    });
  }

  private async run<T>(
    chatId: string | number,
    op: "send" | "edit" | "delete",
    priority: TelegramPriority,
    textLength: number,
    messageId: number | undefined,
    task: () => Promise<T>,
    attempt = 0,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await this.queue.runExclusive(chatId, task);
      this.log({
        chatId,
        op,
        priority,
        attempt,
        ok: true,
        textLength,
        messageId,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = Number(error.parameters?.retry_after ?? 0);
        this.queue.setCooldown(chatId, retryAfter);
        this.log({
          chatId,
          op,
          priority,
          attempt,
          ok: false,
          textLength,
          messageId,
          durationMs: Date.now() - startedAt,
          errorCode: error.error_code,
          retryAfter,
          errorMessage: error.message,
        });

        const maxAttempts = priority === "critical"
          ? 2
          : priority === "normal"
            ? 1
            : 0;
        if (attempt < maxAttempts) {
          return this.run(chatId, op, priority, textLength, messageId, task, attempt + 1);
        }
      } else {
        const errorCode = error instanceof GrammyError ? error.error_code : undefined;
        this.log({
          chatId,
          op,
          priority,
          attempt,
          ok: false,
          textLength,
          messageId,
          durationMs: Date.now() - startedAt,
          errorCode,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private log(event: {
    chatId: string | number;
    op: "send" | "edit" | "delete";
    priority: TelegramPriority;
    attempt: number;
    ok: boolean;
    textLength: number;
    messageId?: number;
    durationMs: number;
    errorCode?: number;
    retryAfter?: number;
    errorMessage?: string;
  }): void {
    if (!this.enableOutboundLogs) {
      return;
    }

    const snapshot = this.queue.getSnapshot(event.chatId);
    console.log(JSON.stringify({
      scope: "telegram_outbound",
      op: event.op,
      chatId: String(event.chatId),
      messageId: event.messageId ?? null,
      priority: event.priority,
      attempt: event.attempt,
      ok: event.ok,
      textLength: event.textLength,
      durationMs: event.durationMs,
      errorCode: event.errorCode ?? null,
      retryAfter: event.retryAfter ?? null,
      errorMessage: event.errorMessage ?? null,
      degraded: snapshot.isDegraded,
      recentOpsCount: snapshot.recentOpsCount,
      recent429Count: snapshot.recent429Count,
      cooldownUntil: snapshot.cooldownUntil,
      lastRoundCompletedAt: snapshot.lastRoundCompletedAt,
    }));
  }

  private isIgnorableEditError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "message is not modified",
      "message to edit not found",
      "message can't be edited",
      "message cant be edited",
    ].some((part) => message.includes(part));
  }

  private isIgnorableDeleteError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "message to delete not found",
      "message can't be deleted",
      "message cant be deleted",
    ].some((part) => message.includes(part));
  }
}
