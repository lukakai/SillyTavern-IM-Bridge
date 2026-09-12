import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldBookDocument } from "../src/core/models/index";
import { WorldBookAdminService } from "../src/core/services/world-book-admin-service";

describe("WorldBookAdminService", () => {
  let backupDirectory: string;

  beforeEach(async () => {
    backupDirectory = await mkdtemp(path.join(os.tmpdir(), "st-im-bridge-world-book-"));
  });

  afterEach(async () => {
    await rm(backupDirectory, { recursive: true, force: true });
  });

  function makeClient(data: WorldBookDocument) {
    return {
      listWorldBooks: vi.fn(async () => [
        { id: "main-lore", name: "主世界书" },
        { id: "other", name: "其他资料" },
      ]),
      getWorldBook: vi.fn(async () => structuredClone(data)),
      saveWorldBook: vi.fn(async () => undefined),
    };
  }

  it("lists, searches and decodes standalone world-book entries", async () => {
    const data: WorldBookDocument = {
      entries: {
        "7": {
          uid: 7,
          comment: "城市设定",
          content: "银月城位于北方。",
          key: ["银月城"],
          keysecondary: ["北方"],
          disable: false,
        },
        "9": {
          uid: 9,
          comment: "隐藏设定",
          content: "尚未启用",
          key: [],
          disable: true,
        },
      },
    };
    const client = makeClient(data);
    const service = new WorldBookAdminService(client as never, backupDirectory);

    await expect(service.listWorldBooks("主世界")).resolves.toEqual([{ id: "main-lore", name: "主世界书" }]);
    const book = await service.getWorldBook("main-lore", "北方");
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]).toMatchObject({
      ref: "7",
      uid: "7",
      comment: "城市设定",
      enabled: true,
      keys: ["银月城"],
      secondaryKeys: ["北方"],
    });
    expect(book.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves a character-linked standalone world book by id or display name", async () => {
    const client = makeClient({ entries: {} });
    const service = new WorldBookAdminService(client as never, backupDirectory);

    await expect(service.resolveWorldBook("main-lore")).resolves.toEqual({ id: "main-lore", name: "主世界书" });
    await expect(service.resolveWorldBook("主世界书.json")).resolves.toEqual({ id: "main-lore", name: "主世界书" });
    await expect(service.resolveWorldBook("不存在")).resolves.toBeNull();
  });

  it("backs up the original document and preserves unknown fields when editing content", async () => {
    const data: WorldBookDocument = {
      name: "主世界书",
      customTopLevel: { keep: true },
      entries: {
        "7": {
          uid: 7,
          comment: "城市设定",
          content: "旧正文",
          key: ["银月城"],
          disable: false,
          customEntryField: { keep: 1 },
        },
      },
    };
    const client = makeClient(data);
    const service = new WorldBookAdminService(client as never, backupDirectory);
    const before = await service.getWorldBook("main-lore");

    const result = await service.updateEntry({
      bookId: "main-lore",
      entryRef: "7",
      expectedRevision: before.revision,
      patch: { content: "新正文" },
    });

    expect(result.entry.content).toBe("新正文");
    expect(client.saveWorldBook).toHaveBeenCalledOnce();
    const saved = client.saveWorldBook.mock.calls[0][1] as WorldBookDocument;
    expect((saved.entries as Record<string, any>)["7"]).toMatchObject({
      content: "新正文",
      customEntryField: { keep: 1 },
    });
    expect(saved.customTopLevel).toEqual({ keep: true });

    const backup = JSON.parse(await readFile(path.join(backupDirectory, result.backupFileName), "utf8"));
    expect(backup.entries["7"].content).toBe("旧正文");
    expect(backup.customTopLevel).toEqual({ keep: true });
  });

  it("toggles the legacy disable flag and refuses a stale revision", async () => {
    const data: WorldBookDocument = {
      entries: {
        "1": { uid: 1, comment: "规则", content: "内容", disable: false },
      },
    };
    const client = makeClient(data);
    const service = new WorldBookAdminService(client as never, backupDirectory);
    const before = await service.getWorldBook("main-lore");

    const toggled = await service.updateEntry({
      bookId: "main-lore",
      entryRef: "1",
      expectedRevision: before.revision,
      patch: { enabled: false },
    });
    expect(toggled.entry.enabled).toBe(false);
    expect(((client.saveWorldBook.mock.calls[0][1] as WorldBookDocument).entries as Record<string, any>)["1"].disable).toBe(true);

    client.getWorldBook.mockResolvedValueOnce({
      entries: {
        "1": { uid: 1, comment: "规则", content: "网页端刚刚改过", disable: false },
      },
    });
    await expect(service.updateEntry({
      bookId: "main-lore",
      entryRef: "1",
      expectedRevision: before.revision,
      patch: { content: "不能覆盖" },
    })).rejects.toThrow("已被其他地方修改");
  });

  it("serializes edits to the same book so concurrent stale writes cannot win", async () => {
    let currentData: WorldBookDocument = {
      entries: {
        "1": { uid: 1, comment: "规则", content: "初始正文", disable: false },
      },
    };
    const client = {
      listWorldBooks: vi.fn(async () => [{ id: "main-lore", name: "主世界书" }]),
      getWorldBook: vi.fn(async () => structuredClone(currentData)),
      saveWorldBook: vi.fn(async (_name: string, data: WorldBookDocument) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentData = structuredClone(data);
      }),
    };
    const service = new WorldBookAdminService(client as never, backupDirectory);
    const before = await service.getWorldBook("main-lore");

    const results = await Promise.allSettled([
      service.updateEntry({
        bookId: "main-lore",
        entryRef: "1",
        expectedRevision: before.revision,
        patch: { content: "第一份修改" },
      }),
      service.updateEntry({
        bookId: "main-lore",
        entryRef: "1",
        expectedRevision: before.revision,
        patch: { content: "第二份修改" },
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((currentData.entries as Record<string, any>)["1"].content).toBe("第一份修改");
  });
});
