import type { Context } from "grammy";
import type { MvuStatusSnapshot } from "../../core/models/index";
import { renderTelegramResponse, splitTelegramResponse, splitTelegramText, type TelegramMessagePart } from "./render";
import { TelegramSender } from "./telegram-sender";

type BotContext = Context;

interface StreamRendererOptions {
  minRenderIntervalMs?: number;
  minDeltaChars?: number;
  firstRenderMinChars?: number;
  hardChunkSize?: number;
  degraded?: boolean;
  progressSingleMessageOnly?: boolean;
  disableProgressWhenDegraded?: boolean;
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
    const rendered = renderTelegramResponse(fullText, mvuStatus);
    const parts = splitTelegramResponse(rendered, this.hardChunkSize);
    await this.applyParts(parts, "critical", true, rendered.keyboard ?? undefined);
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
