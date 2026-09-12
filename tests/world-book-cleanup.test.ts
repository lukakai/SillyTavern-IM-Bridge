import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldBookMessageCleanup } from "../src/delivery/telegram/world-book-cleanup";

describe("WorldBookMessageCleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("deletes only tracked bot messages after 15 minutes without activity", async () => {
    const remove = vi.fn(async (_id: number) => undefined);
    const cleanup = new WorldBookMessageCleanup(remove, 15 * 60_000);
    cleanup.track(10);
    cleanup.track(11);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    cleanup.touch();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remove.mock.calls).toEqual([[10], [11]]);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("keeps every menu message throughout editing and confirmation until resumed", async () => {
    const remove = vi.fn(async (_id: number) => undefined);
    const cleanup = new WorldBookMessageCleanup(remove, 15 * 60_000);
    cleanup.track(20);
    cleanup.pause();
    cleanup.track(21); // Edit prompt, not the user's submitted content.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    cleanup.track(22); // Confirmation preview.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(remove).not.toHaveBeenCalled();
    cleanup.track(23); // Saved notice.
    cleanup.resume();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(remove.mock.calls).toEqual([[20], [21], [22], [23]]);
  });

  it("continues after an already-deleted Telegram message", async () => {
    const remove = vi.fn(async (id: number) => {
      if (id === 30) throw new Error("message not found");
    });
    const cleanup = new WorldBookMessageCleanup(remove, 15 * 60_000);
    cleanup.track(30);
    cleanup.track(31);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(remove.mock.calls).toEqual([[30], [31]]);
  });

  it("stops deleting remaining messages when editing begins during cleanup", async () => {
    let releaseFirst!: () => void;
    const firstDeletion = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const remove = vi.fn(async (id: number) => {
      if (id === 40) await firstDeletion;
    });
    const cleanup = new WorldBookMessageCleanup(remove, 15 * 60_000);
    cleanup.track(40);
    cleanup.track(41);
    const elapsed = vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(40));
    cleanup.pause();
    releaseFirst();
    await elapsed;
    expect(remove).toHaveBeenCalledTimes(1);
    cleanup.resume();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(remove.mock.calls).toEqual([[40], [41]]);
  });
});
