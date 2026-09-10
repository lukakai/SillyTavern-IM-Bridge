import type { Context } from "grammy";
import type { MvuStatusSnapshot } from "../../core/models/index";
import { renderTelegramResponse, splitTelegramResponse, splitTelegramText, type TelegramMessagePart } from "./render";
import { TelegramSender } from "./telegram-sender";
import { combineInlineKeyboards, renderSwipeKeyboard } from "./swipe";

type BotContext = Context;

interface StreamRendererOptions {
  minRenderIntervalMs?: number;
  minDeltaChars?: number;
  firstRenderMinChars?: number;
  hardChunkSize?: number;
  degraded?: boolean;
  progressSingleMessageOnly?: boolean;
  disableProgressWhenDegraded?: boolean;
  xuanxiangCallbackId?: string | null;
  swipeIndex?: number;
  swipeCount?: number;
}

export class StreamRenderer {
  private readonly messageIds: number[];
  private readonly sentParts: string[];
  private lastRenderedText = "";
  private lastRenderAt = 0;
  private lastCommittedLength = 0;
  private readonly minRenderIntervalMs: number;
  private readonly minDeltaChars: number;
  private readonly firstRenderMinChars: number;
  private readonly hardChunkSize: number;
  private readonly degraded: boolean;
  private readonly progressSingleMessageOnly: boolean;
  private readonly disableProgressWhenDegraded: boolean;
  private readonly xuanxiangCallbackId: string | null;
  private readonly swipeIndex: number;
  private readonly swipeCount: number;
  private swipeControlMessageId: number | null = null;
  private xuanxiangMessageId: number | null = null;

  public constructor(
    private readonly ctx: BotContext,
    private readonly sender: TelegramSender,
    private readonly chatId: number,
    initialMessageId: number,
    options: StreamRendererOptions = {},
  ) {
    this.messageIds = [initialMessageId];
    this.sentParts = [""];
    this.minRenderIntervalMs = options.minRenderIntervalMs ?? 5000;
    this.minDeltaChars = options.minDeltaChars ?? 700;
    this.firstRenderMinChars = options.firstRenderMinChars ?? 300;
    this.hardChunkSize = options.hardChunkSize ?? 3200;
    this.degraded = options.degraded ?? false;
    this.progressSingleMessageOnly = options.progressSingleMessageOnly ?? true;
    this.disableProgressWhenDegraded = options.disableProgressWhenDegraded ?? true;
    this.xuanxiangCallbackId = options.xuanxiangCallbackId ?? null;
    this.swipeIndex = options.swipeIndex ?? 0;
    this.swipeCount = options.swipeCount ?? 1;
  }

  public async onProgress(fullText: string): Promise<void> {
    if (!fullText) {
      return;
    }

    if (this.degraded && this.disableProgressWhenDegraded) {
      return;
    }

    if (this.lastCommittedLength === 0 && fullText.length < this.firstRenderMinChars) {
      return;
    }

    const now = Date.now();
    const deltaChars = fullText.length - this.lastCommittedLength;
    if (this.lastCommittedLength > 0 && now - this.lastRenderAt < this.minRenderIntervalMs && deltaChars < this.minDeltaChars) {
      return;
    }

    await this.renderProgress(fullText);
  }

  public async onDone(finalText: string, mvuStatus: MvuStatusSnapshot | null = null): Promise<void> {
    if (!finalText) {
      return;
    }

    await this.renderFinal(finalText, mvuStatus);
    this.sender.markRoundCompleted(this.chatId);
  }

  public getMessageIds(): number[] {
    return [...this.messageIds];
  }

  public getSwipeControlMessageId(): number | null {
    return this.swipeControlMessageId;
  }

  public getXuanxiangMessageId(): number | null {
    return this.xuanxiangMessageId;
  }

  private async renderProgress(fullText: string): Promise<void> {
    if (fullText === this.lastRenderedText) {
      return;
    }

    const parts = splitTelegramText(fullText, this.hardChunkSize);
    const progressParts = this.progressSingleMessageOnly ? [parts[0] ?? fullText] : parts;
    await this.applyParts(progressParts, "ephemeral", false);
    this.lastRenderedText = fullText;
    this.lastCommittedLength = fullText.length;
    this.lastRenderAt = Date.now();
  }

  private async renderFinal(fullText: string, mvuStatus: MvuStatusSnapshot | null): Promise<void> {
    const rendered = renderTelegramResponse(fullText, mvuStatus, {
      xuanxiangCallbackId: this.xuanxiangCallbackId,
    });
    const swipeKeyboard = this.xuanxiangCallbackId
      ? renderSwipeKeyboard(this.xuanxiangCallbackId, this.swipeIndex, this.swipeCount)
      : undefined;
    const parts = splitTelegramResponse(rendered, this.hardChunkSize);
    if (parts.length > 0) {
      await this.applyParts(parts, "critical", true, combineInlineKeyboards(rendered.keyboard, swipeKeyboard));
      this.swipeControlMessageId = this.messageIds[parts.length - 1] ?? null;
    }
    if (rendered.xuanxiang) {
      const panel = rendered.xuanxiang;
      if (parts.length === 0) {
        await this.applyParts(
          [{ text: panel.text }],
          "critical",
          true,
          combineInlineKeyboards(panel.keyboard, swipeKeyboard),
        );
        this.swipeControlMessageId = this.messageIds[0] ?? null;
        this.xuanxiangMessageId = this.messageIds[0] ?? null;
      } else {
        const message = await this.sender.sendText(this.ctx, this.chatId, panel.text, {
          priority: "critical",
          replyMarkup: panel.keyboard ?? undefined,
        });
        this.messageIds.push(message.message_id);
        this.sentParts.push(panel.text);
        this.xuanxiangMessageId = message.message_id;
      }
    }
    this.lastRenderedText = fullText;
    this.lastCommittedLength = fullText.length;
    this.lastRenderAt = Date.now();
  }

  private async applyParts(
    parts: Array<string | TelegramMessagePart>,
    priority: "ephemeral" | "critical",
    allowAdditionalMessages: boolean,
    finalReplyMarkup: unknown = undefined,
  ): Promise<void> {
    for (let index = 0; index < parts.length; index += 1) {
      const rawPart = parts[index];
      const part = typeof rawPart === "string" ? { text: rawPart } : rawPart;
      const replyMarkup = index === parts.length - 1 ? finalReplyMarkup : undefined;
      if (index < this.messageIds.length) {
        if (this.sentParts[index] !== part.text || replyMarkup !== undefined || part.entities !== undefined) {
          await this.sender.editText(this.ctx, this.chatId, this.messageIds[index], part.text, {
            priority,
            replyMarkup,
            entities: part.entities,
          });
          this.sentParts[index] = part.text;
        }
        continue;
      }

      if (!allowAdditionalMessages) {
        break;
      }

      const message = await this.sender.sendText(this.ctx, this.chatId, part.text, {
        priority,
        replyMarkup,
        entities: part.entities,
      });
      this.messageIds.push(message.message_id);
      this.sentParts.push(part.text);
    }
  }
}
