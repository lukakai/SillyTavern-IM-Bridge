import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqlitePersistence } from "../src/infra/persistence/sqlite-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-im-bridge-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRepo() {
  const dbPath = path.join(tmpDir, "app.db");
  const persistence = createSqlitePersistence(dbPath);
  return { dbPath, persistence };
}

describe("AccountConfigRepository", () => {
  it("creates default config row on ensure()", () => {
    const { persistence } = makeRepo();
    persistence.accountRepository.ensureSTUserAccount({ handle: "alice", role: "admin" });
    const cfg = persistence.accountConfigRepository.ensure("handle:alice");
    expect(cfg.accountId).toBe("handle:alice");
    expect(cfg.botEnabled).toBe(false);
    expect(cfg.telegramAllowedUserIds).toEqual([]);
    expect(cfg.compress.keepRecent).toBe(15);
    persistence.close();
  });

  it("upserts patches incrementally without losing other fields", () => {
    const { persistence } = makeRepo();
    persistence.accountRepository.ensureSTUserAccount({ handle: "bob", role: "user" });
    const accountId = "handle:bob";
    persistence.accountConfigRepository.upsert(accountId, { telegramBotToken: "abc:123" });
    persistence.accountConfigRepository.upsert(accountId, { telegramAllowedUserIds: ["111", "222"], botEnabled: true });
    const cfg = persistence.accountConfigRepository.get(accountId);
    expect(cfg?.telegramBotToken).toBe("abc:123");
    expect(cfg?.telegramAllowedUserIds).toEqual(["111", "222"]);
    expect(cfg?.botEnabled).toBe(true);
    persistence.accountConfigRepository.upsert(accountId, { tg: { advanced: { promptMode: "enhanced" } } });
    expect(persistence.accountConfigRepository.get(accountId)?.tg.advanced.promptMode).toBe("enhanced");
    expect(persistence.accountConfigRepository.get(accountId)?.telegramBotToken).toBe("abc:123");
    persistence.close();
  });

  it("listEnabledWithToken filters correctly", () => {
    const { persistence } = makeRepo();
    persistence.accountRepository.ensureSTUserAccount({ handle: "u1", role: "user" });
    persistence.accountRepository.ensureSTUserAccount({ handle: "u2", role: "user" });
    persistence.accountRepository.ensureSTUserAccount({ handle: "u3", role: "user" });
    persistence.accountConfigRepository.upsert("handle:u1", { telegramBotToken: "T1", botEnabled: true });
    persistence.accountConfigRepository.upsert("handle:u2", { telegramBotToken: "T2", botEnabled: false });
    persistence.accountConfigRepository.upsert("handle:u3", { telegramBotToken: null, botEnabled: true });
    const enabled = persistence.accountConfigRepository.listEnabledWithToken();
    expect(enabled.map((c) => c.accountId)).toEqual(["handle:u1"]);
    persistence.close();
  });
});

describe("ensureSTUserAccount", () => {
  it("creates a handle-scoped account and lists it", () => {
    const { persistence } = makeRepo();
    persistence.accountRepository.ensureSTUserAccount({ handle: "rin", displayName: "Rin", role: "admin" });
    const acc = persistence.accountRepository.getSTUserAccount("handle:rin");
    expect(acc?.stUserHandle).toBe("rin");
    expect(acc?.role).toBe("admin");
    expect(acc?.displayName).toBe("Rin");
    const list = persistence.accountRepository.listSTUserAccounts();
    expect(list).toHaveLength(1);
    persistence.close();
  });

  it("re-ensure updates role without dropping other fields", () => {
    const { persistence } = makeRepo();
    persistence.accountRepository.ensureSTUserAccount({ handle: "kai", displayName: "Kai", role: "user" });
    persistence.accountRepository.ensureSTUserAccount({ handle: "kai", role: "admin" });
    const acc = persistence.accountRepository.getSTUserAccount("handle:kai");
    expect(acc?.role).toBe("admin");
    expect(acc?.displayName).toBe("Kai");
    persistence.close();
  });
});
