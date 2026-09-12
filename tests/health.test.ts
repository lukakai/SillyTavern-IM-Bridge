import { describe, expect, it, vi } from "vitest";
import { buildHealthSnapshot, renderHealthSnapshot } from "../src/plugin/health";

function services(options: { botStatus?: "running" | "error"; databaseError?: boolean } = {}) {
  return {
    repositories: {
      db: {
        prepare: vi.fn(() => ({
          get: vi.fn(() => {
            if (options.databaseError) throw new Error("database closed");
            return { ok: 1 };
          }),
        })),
      },
      accountConfigRepository: {
        listAll: vi.fn(() => [{ accountId: "account", botEnabled: true, telegramBotToken: "token" }]),
      },
    },
    botManager: {
      list: vi.fn(() => options.botStatus ? [{ status: options.botStatus }] : [{ status: "running" }]),
    },
    webRelayService: {
      getStatus: vi.fn(() => ({
        online: true,
        workerCount: 1,
        pendingJobs: 0,
        activeJobs: 0,
        relayVersion: "1.2.2",
      })),
    },
  } as never;
}

describe("health snapshot", () => {
  it("reports healthy aggregate status without exposing credentials", () => {
    const snapshot = buildHealthSnapshot(services());
    expect(snapshot.status).toBe("healthy");
    expect(snapshot.checks.telegram).toMatchObject({ configured: 1, running: 1, errors: 0 });
    expect(snapshot.checks.webRelay).toMatchObject({
      onlineAccounts: 1,
      workers: 1,
      relayVersions: ["1.2.2"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("token");
    expect(renderHealthSnapshot(snapshot)).toContain("系统状态：🟢 正常");
    expect(renderHealthSnapshot(snapshot)).toContain("中继版本：1.2.2");
  });

  it("reports a terminal bot error as degraded instead of unhealthy", () => {
    const snapshot = buildHealthSnapshot(services({ botStatus: "error" }));
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.checks.telegram.errors).toBe(1);
  });

  it("reports a database failure as unhealthy", () => {
    const snapshot = buildHealthSnapshot(services({ databaseError: true }));
    expect(snapshot.status).toBe("unhealthy");
    expect(snapshot.checks.database.status).toBe("error");
  });
});
