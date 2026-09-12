import crypto from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorldBookDocument,
  WorldBookEntryUpdateResult,
  WorldBookEntryView,
  WorldBookSummary,
  WorldBookView,
} from "../models/index";
import { StClient } from "../../infra/st/st-client";
import { AppError } from "../../shared/errors/app-error";

interface WorldBookEntryPatch {
  content?: string;
  enabled?: boolean;
}

interface RawEntryLocation {
  entry: Record<string, unknown>;
  ref: string;
}

const MAX_CONTENT_LENGTH = 500_000;

function documentRevision(data: WorldBookDocument): string {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function rawEntryLocations(data: WorldBookDocument): RawEntryLocation[] {
  if (Array.isArray(data.entries)) {
    return data.entries.flatMap((value, index) => value && typeof value === "object"
      ? [{ entry: value as Record<string, unknown>, ref: String(index) }]
      : []);
  }
  return Object.entries(data.entries).flatMap(([ref, value]) => value && typeof value === "object"
    ? [{ entry: value as Record<string, unknown>, ref }]
    : []);
}

function entryView(location: RawEntryLocation): WorldBookEntryView {
  const { entry, ref } = location;
  const uid = typeof entry.uid === "number" || typeof entry.uid === "string" ? String(entry.uid) : ref;
  const hasLegacyDisable = typeof entry.disable === "boolean";
  return {
    ref,
    uid,
    comment: typeof entry.comment === "string" ? entry.comment.trim() : "",
    content: typeof entry.content === "string" ? entry.content : "",
    keys: textArray(entry.key),
    secondaryKeys: textArray(entry.keysecondary),
    enabled: hasLegacyDisable ? entry.disable !== true : entry.enabled !== false,
  };
}

function matchesQuery(entry: WorldBookEntryView, query: string): boolean {
  if (!query) return true;
  const haystack = [entry.uid, entry.comment, entry.content, ...entry.keys, ...entry.secondaryKeys]
    .join("\n")
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

function normalizedBookReference(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\.json$/i, "")
    .toLocaleLowerCase();
}

export class WorldBookAdminService {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly stClient: StClient,
    private readonly backupDirectory: string,
    private readonly maxBackupsPerBook = 20,
  ) {}

  public async listWorldBooks(search = ""): Promise<WorldBookSummary[]> {
    const items = await this.stClient.listWorldBooks();
    const query = search.trim().toLocaleLowerCase();
    return query
      ? items.filter((item) => `${item.name}\n${item.id}`.toLocaleLowerCase().includes(query))
      : items;
  }

  public async resolveWorldBook(reference: string): Promise<WorldBookSummary | null> {
    const raw = String(reference ?? "").trim();
    if (!raw) return null;
    const items = await this.stClient.listWorldBooks();
    const exact = items.find((item) => item.id === raw || item.name === raw);
    if (exact) return exact;
    const normalized = normalizedBookReference(raw);
    return items.find((item) => (
      normalizedBookReference(item.id) === normalized
      || normalizedBookReference(item.name) === normalized
    )) ?? null;
  }

  public async getWorldBook(bookId: string, entrySearch = ""): Promise<WorldBookView> {
    const summary = await this.requireBook(bookId);
    const data = await this.stClient.getWorldBook(summary.id);
    return this.toView(summary, data, entrySearch);
  }

  public async updateEntry(params: {
    bookId: string;
    entryRef: string;
    expectedRevision: string;
    patch: WorldBookEntryPatch;
  }): Promise<WorldBookEntryUpdateResult> {
    const queueKey = String(params.bookId ?? "").trim();
    const previous = this.mutationQueues.get(queueKey) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.updateEntryExclusive(params));
    this.mutationQueues.set(queueKey, current);
    try {
      return await current;
    } finally {
      if (this.mutationQueues.get(queueKey) === current) this.mutationQueues.delete(queueKey);
    }
  }

  private async updateEntryExclusive(params: {
    bookId: string;
    entryRef: string;
    expectedRevision: string;
    patch: WorldBookEntryPatch;
  }): Promise<WorldBookEntryUpdateResult> {
    const summary = await this.requireBook(params.bookId);
    const data = await this.stClient.getWorldBook(summary.id);
    const actualRevision = documentRevision(data);
    if (!params.expectedRevision || params.expectedRevision !== actualRevision) {
      throw new AppError(
        "WORLD_BOOK_CONFLICT",
        "世界书在你确认前已被其他地方修改。为避免覆盖新内容，本次保存已取消；请重新打开条目再编辑。",
        409,
      );
    }

    const location = rawEntryLocations(data).find((item) => item.ref === params.entryRef);
    if (!location) {
      throw new AppError("WORLD_BOOK_ENTRY_NOT_FOUND", "这个世界书条目已经不存在，请重新打开世界书。", 404);
    }

    const hasContent = Object.prototype.hasOwnProperty.call(params.patch, "content");
    const hasEnabled = typeof params.patch.enabled === "boolean";
    if (!hasContent && !hasEnabled) {
      throw new AppError("WORLD_BOOK_PATCH_EMPTY", "没有需要保存的世界书修改。", 400);
    }
    const backupData = structuredClone(data);
    if (hasContent) {
      if (typeof params.patch.content !== "string") {
        throw new AppError("WORLD_BOOK_CONTENT_INVALID", "世界书正文必须是文本。", 400);
      }
      if (params.patch.content.length > MAX_CONTENT_LENGTH) {
        throw new AppError("WORLD_BOOK_CONTENT_TOO_LARGE", "世界书正文超过 500000 字符，已拒绝保存。", 413);
      }
      location.entry.content = params.patch.content;
    }
    if (hasEnabled) {
      const enabled = params.patch.enabled!;
      if (Object.prototype.hasOwnProperty.call(location.entry, "disable")
        || !Object.prototype.hasOwnProperty.call(location.entry, "enabled")) {
        location.entry.disable = !enabled;
      }
      if (Object.prototype.hasOwnProperty.call(location.entry, "enabled")) {
        location.entry.enabled = enabled;
      }
    }

    const backupFileName = await this.backup(summary.id, actualRevision, backupData);
    await this.stClient.saveWorldBook(summary.id, data);
    await this.pruneBackups(summary.id).catch((error) => {
      console.warn(JSON.stringify({
        scope: "world_book_backup",
        event: "prune_failed",
        bookId: summary.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    const book = this.toView(summary, data);
    const entry = book.entries.find((item) => item.ref === params.entryRef)!;
    return { book, entry, backupFileName };
  }

  private async requireBook(bookId: string): Promise<WorldBookSummary> {
    const id = String(bookId ?? "").trim();
    if (!id) throw new AppError("WORLD_BOOK_REQUIRED", "请选择世界书。", 400);
    const summary = (await this.stClient.listWorldBooks()).find((item) => item.id === id);
    if (!summary) throw new AppError("WORLD_BOOK_NOT_FOUND", `没有找到独立世界书：${id}`, 404);
    return summary;
  }

  private toView(summary: WorldBookSummary, data: WorldBookDocument, entrySearch = ""): WorldBookView {
    const query = entrySearch.trim();
    return {
      id: summary.id,
      name: summary.name,
      revision: documentRevision(data),
      entries: rawEntryLocations(data).map(entryView).filter((entry) => matchesQuery(entry, query)),
    };
  }

  private bookBackupPrefix(bookId: string): string {
    return crypto.createHash("sha256").update(bookId).digest("hex").slice(0, 16);
  }

  private async backup(bookId: string, revision: string, data: WorldBookDocument): Promise<string> {
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const prefix = this.bookBackupPrefix(bookId);
    const safeBookName = bookId.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || "world-book";
    const fileName = `${prefix}-${safeBookName}-${Date.now()}-${revision.slice(0, 12)}.json`;
    const target = path.join(this.backupDirectory, fileName);
    const temporary = path.join(this.backupDirectory, `.${fileName}.${crypto.randomUUID()}.tmp`);
    // Keep the backup directly importable by SillyTavern's World Info importer.
    const payload = JSON.stringify(data, null, 2);
    await writeFile(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    return fileName;
  }

  private async pruneBackups(bookId: string): Promise<void> {
    const keep = Math.max(1, this.maxBackupsPerBook);
    const prefix = `${this.bookBackupPrefix(bookId)}-`;
    const names = (await readdir(this.backupDirectory))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort()
      .reverse();
    await Promise.all(names.slice(keep).map((name) => unlink(path.join(this.backupDirectory, name)).catch(() => undefined)));
  }
}
