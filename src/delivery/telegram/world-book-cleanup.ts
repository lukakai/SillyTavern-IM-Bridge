/** Only tracks bot-owned world-book messages; never tracks the user's replies. */
export class WorldBookMessageCleanup {
  private readonly messageIds = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  public constructor(
    private readonly deleteMessage: (messageId: number) => Promise<void>,
    private readonly idleTimeoutMs: number,
  ) {}

  public track(messageId: number): void {
    if (Number.isInteger(messageId) && messageId > 0) this.messageIds.add(messageId);
    this.touch();
  }

  public pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  public resume(): void {
    this.paused = false;
    this.touch();
  }

  public touch(): void {
    this.clearTimer();
    if (this.paused || this.messageIds.size === 0) return;
    this.timer = setTimeout(() => { void this.clearMessages(); }, this.idleTimeoutMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async clearMessages(): Promise<void> {
    this.timer = null;
    for (const messageId of [...this.messageIds]) {
      if (this.paused) break;
      this.messageIds.delete(messageId);
      try {
        await this.deleteMessage(messageId);
      } catch {
        // Telegram may already have deleted the message, or the bot may lack permission.
      }
    }
    if (!this.paused) this.touch();
  }
}
