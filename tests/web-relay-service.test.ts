import { afterEach, describe, expect, it } from "vitest";
import { WebRelayService } from "../src/core/services/web-relay-service";

const openServices: WebRelayService[] = [];

function createService(): WebRelayService {
  const service = new WebRelayService({
    jobTimeoutMs: 2_000,
    presenceTimeoutMs: 2_000,
    leaseTimeoutMs: 1_000,
    maxPollWaitMs: 20,
  });
  openServices.push(service);
  return service;
}

afterEach(() => {
  for (const service of openServices.splice(0)) service.close();
});

describe("WebRelayService", () => {
  it("rejects generation while no authenticated page is online", async () => {
    const service = createService();
    await expect(service.execute({
      accountId: "account",
      operation: "send",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "你好",
    })).rejects.toMatchObject({ code: "WEB_RELAY_OFFLINE" });
  });

  it("delivers one job to a worker and resolves its completion", async () => {
    const service = createService();
    service.heartbeat("account", { workerId: "worker", relayVersion: "1.0.0", pageUrl: "/" });
    const execution = service.execute({
      accountId: "account",
      operation: "send",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "你好",
      modelOverride: "model-a",
    });

    const job = await service.poll("account", { workerId: "worker" }, 0);
    expect(job).toMatchObject({
      operation: "send",
      avatar: "card.png",
      chatFile: "chat",
      text: "你好",
      modelOverride: "model-a",
    });
    service.complete("account", "worker", job!.id, {
      messageIndex: 2,
      chatId: "chat",
      characterAvatar: "card.png",
    });

    await expect(execution).resolves.toEqual({
      messageIndex: 2,
      chatId: "chat",
      characterAvatar: "card.png",
    });
    expect(service.getStatus("account")).toMatchObject({ pendingJobs: 0, activeJobs: 0 });
  });

  it("does not let a different browser finish a claimed job", async () => {
    const service = createService();
    service.heartbeat("account", { workerId: "worker-a" });
    const execution = service.execute({
      accountId: "account",
      operation: "regenerate",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
    });
    const job = await service.poll("account", { workerId: "worker-a" }, 0);

    expect(() => service.complete("account", "worker-b", job!.id, {}))
      .toThrowError(/不属于当前网页中继/);
    service.fail("account", "worker-a", job!.id, "上游 API 错误");
    await expect(execution).rejects.toMatchObject({
      code: "WEB_RELAY_GENERATE_FAILED",
      message: expect.stringContaining("上游 API 错误"),
    });
  });

  it("supports long polling when a job arrives after the poll starts", async () => {
    const service = createService();
    const poll = service.poll("account", { workerId: "worker" }, 20);
    const execution = service.execute({
      accountId: "account",
      operation: "send",
      avatar: "card.png",
      characterName: "角色",
      chatFile: "chat",
      text: "稍后到达",
    });
    const job = await poll;
    expect(job?.text).toBe("稍后到达");
    service.complete("account", "worker", job!.id, {});
    await execution;
  });
});
