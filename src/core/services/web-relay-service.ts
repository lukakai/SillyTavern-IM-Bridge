import crypto from "node:crypto";
import { AppError } from "../../shared/errors/app-error";

export type WebRelayOperation = "send" | "regenerate";

export interface WebRelayJob {
  id: string;
  operation: WebRelayOperation;
  avatar: string;
  characterName: string;
  chatFile: string;
  text: string | null;
  modelOverride: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface WebRelayCompletion {
  messageIndex: number | null;
  chatId: string | null;
  characterAvatar: string | null;
}

export interface WebRelayStatus {
  online: boolean;
  workerCount: number;
  lastSeenAt: string | null;
  relayVersion: string | null;
  pageUrl: string | null;
  pendingJobs: number;
  activeJobs: number;
}

interface WebRelayServiceOptions {
  jobTimeoutMs: number;
  presenceTimeoutMs: number;
  leaseTimeoutMs: number;
  maxPollWaitMs: number;
}

interface RelayPresence {
  workerId: string;
  lastSeenMs: number;
  relayVersion: string | null;
  pageUrl: string | null;
}

interface InternalJob {
  accountId: string;
  publicJob: WebRelayJob;
  state: "pending" | "claimed";
  claimedBy: string | null;
  leaseUntilMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (completion: WebRelayCompletion) => void;
  reject: (error: Error) => void;
}

interface RelayIdentity {
  workerId: string;
  relayVersion?: string | null;
  pageUrl?: string | null;
}

const DEFAULT_OPTIONS: WebRelayServiceOptions = {
  jobTimeoutMs: 900_000,
  presenceTimeoutMs: 120_000,
  leaseTimeoutMs: 120_000,
  maxPollWaitMs: 25_000,
};

function requiredText(value: string, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new AppError("WEB_RELAY_INVALID_JOB", `${label}不能为空`, 400);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * In-memory rendezvous between Telegram generations and an authenticated ST page.
 * Jobs intentionally do not survive an ST restart: callers receive an explicit error
 * and can safely retry instead of risking a duplicate generation.
 */
export class WebRelayService {
  private readonly options: WebRelayServiceOptions;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly jobOrderByAccount = new Map<string, string[]>();
  private readonly presenceByAccount = new Map<string, Map<string, RelayPresence>>();
  private readonly waitersByAccount = new Map<string, Set<() => void>>();
  private closed = false;

  public constructor(options: Partial<WebRelayServiceOptions> = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      jobTimeoutMs: Math.max(1_000, options.jobTimeoutMs ?? DEFAULT_OPTIONS.jobTimeoutMs),
      presenceTimeoutMs: Math.max(1_000, options.presenceTimeoutMs ?? DEFAULT_OPTIONS.presenceTimeoutMs),
      leaseTimeoutMs: Math.max(1_000, options.leaseTimeoutMs ?? DEFAULT_OPTIONS.leaseTimeoutMs),
      maxPollWaitMs: Math.max(0, options.maxPollWaitMs ?? DEFAULT_OPTIONS.maxPollWaitMs),
    };
  }

  public heartbeat(accountId: string, identity: RelayIdentity, activeJobId?: string | null): WebRelayStatus {
    if (this.closed) throw new AppError("WEB_RELAY_CLOSED", "网页中继服务正在关闭", 503);
    const workerId = requiredText(identity.workerId, "workerId");
    const now = Date.now();
    this.prunePresence(accountId, now);
    const workers = this.presenceByAccount.get(accountId) ?? new Map<string, RelayPresence>();
    workers.set(workerId, {
      workerId,
      lastSeenMs: now,
      relayVersion: optionalText(identity.relayVersion),
      pageUrl: optionalText(identity.pageUrl),
    });
    this.presenceByAccount.set(accountId, workers);

    if (activeJobId) {
      const job = this.jobs.get(activeJobId);
      if (job?.accountId === accountId && job.claimedBy === workerId && job.state === "claimed") {
        job.leaseUntilMs = now + this.options.leaseTimeoutMs;
      }
    }

    return this.getStatus(accountId);
  }

  public getStatus(accountId: string): WebRelayStatus {
    const now = Date.now();
    this.prunePresence(accountId, now);
    this.expireStaleClaims(accountId, now);
    const workers = [...(this.presenceByAccount.get(accountId)?.values() ?? [])]
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs);
    const accountJobs = this.accountJobs(accountId);
    return {
      online: workers.length > 0,
      workerCount: workers.length,
      lastSeenAt: workers[0] ? new Date(workers[0].lastSeenMs).toISOString() : null,
      relayVersion: workers[0]?.relayVersion ?? null,
      pageUrl: workers[0]?.pageUrl ?? null,
      pendingJobs: accountJobs.filter((job) => job.state === "pending").length,
      activeJobs: accountJobs.filter((job) => job.state === "claimed").length,
    };
  }

  public async execute(params: {
    accountId: string;
    operation: WebRelayOperation;
    avatar: string;
    characterName: string;
    chatFile: string;
    text?: string | null;
    modelOverride?: string | null;
  }): Promise<WebRelayCompletion> {
    if (this.closed) throw new AppError("WEB_RELAY_CLOSED", "网页中继服务正在关闭", 503);
    if (!this.getStatus(params.accountId).online) {
      throw new AppError(
        "WEB_RELAY_OFFLINE",
        "网页完整模式中继未在线。请在 Mac mini 的专用 SillyTavern 页面中启用 IM Bridge 网页中继。",
        503,
      );
    }

    const accountId = requiredText(params.accountId, "accountId");
    const now = Date.now();
    const id = crypto.randomUUID();
    const publicJob: WebRelayJob = {
      id,
      operation: params.operation,
      avatar: requiredText(params.avatar, "avatar"),
      characterName: requiredText(params.characterName, "characterName"),
      chatFile: requiredText(params.chatFile, "chatFile"),
      text: params.operation === "send" ? String(params.text ?? "") : null,
      modelOverride: optionalText(params.modelOverride),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.jobTimeoutMs).toISOString(),
    };

    return new Promise<WebRelayCompletion>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeJob(id);
        reject(new AppError(
          "WEB_RELAY_TIMEOUT",
          `网页完整模式生成超时（${Math.round(this.options.jobTimeoutMs / 1000)} 秒）`,
          504,
        ));
      }, this.options.jobTimeoutMs);
      timer.unref?.();

      this.jobs.set(id, {
        accountId,
        publicJob,
        state: "pending",
        claimedBy: null,
        leaseUntilMs: 0,
        timer,
        resolve,
        reject,
      });
      const order = this.jobOrderByAccount.get(accountId) ?? [];
      order.push(id);
      this.jobOrderByAccount.set(accountId, order);
      this.notifyPollers(accountId);
    });
  }

  public async poll(accountId: string, identity: RelayIdentity, requestedWaitMs?: number): Promise<WebRelayJob | null> {
    this.heartbeat(accountId, identity);
    const waitMs = Math.min(
      this.options.maxPollWaitMs,
      Math.max(0, Number.isFinite(requestedWaitMs) ? Number(requestedWaitMs) : this.options.maxPollWaitMs),
    );
    const immediate = this.claimNext(accountId, identity.workerId);
    if (immediate || waitMs <= 0) return immediate;

    await new Promise<void>((resolve) => {
      const waiters = this.waitersByAccount.get(accountId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.waitersByAccount.delete(accountId);
        resolve();
      };
      waiters.add(finish);
      this.waitersByAccount.set(accountId, waiters);
      timer = setTimeout(finish, waitMs);
      timer.unref?.();
    });

    this.heartbeat(accountId, identity);
    return this.claimNext(accountId, identity.workerId);
  }

  public complete(accountId: string, workerId: string, jobId: string, completion: Partial<WebRelayCompletion>): void {
    const job = this.requireClaimedJob(accountId, workerId, jobId);
    this.removeJob(jobId);
    job.resolve({
      messageIndex: Number.isInteger(completion.messageIndex) ? Number(completion.messageIndex) : null,
      chatId: optionalText(completion.chatId),
      characterAvatar: optionalText(completion.characterAvatar),
    });
  }

  public fail(accountId: string, workerId: string, jobId: string, message: string): void {
    const job = this.requireClaimedJob(accountId, workerId, jobId);
    this.removeJob(jobId);
    job.reject(new AppError(
      "WEB_RELAY_GENERATE_FAILED",
      `酒馆网页生成失败：${String(message || "未知错误").slice(0, 1000)}`,
      502,
    ));
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, job] of this.jobs) {
      clearTimeout(job.timer);
      job.reject(new AppError("WEB_RELAY_CLOSED", "网页中继服务已停止，请重新发送消息", 503));
      this.jobs.delete(id);
    }
    for (const waiters of this.waitersByAccount.values()) {
      for (const finish of waiters) finish();
    }
    this.jobOrderByAccount.clear();
    this.presenceByAccount.clear();
    this.waitersByAccount.clear();
  }

  private accountJobs(accountId: string): InternalJob[] {
    return (this.jobOrderByAccount.get(accountId) ?? [])
      .map((id) => this.jobs.get(id))
      .filter((job): job is InternalJob => Boolean(job));
  }

  private claimNext(accountId: string, workerId: string): WebRelayJob | null {
    const now = Date.now();
    this.expireStaleClaims(accountId, now);
    const job = this.accountJobs(accountId).find((candidate) => candidate.state === "pending");
    if (!job) return null;
    job.state = "claimed";
    job.claimedBy = requiredText(workerId, "workerId");
    job.leaseUntilMs = now + this.options.leaseTimeoutMs;
    return { ...job.publicJob };
  }

  private expireStaleClaims(accountId: string, now: number): void {
    for (const job of this.accountJobs(accountId)) {
      if (job.state === "claimed" && job.leaseUntilMs <= now) {
        this.removeJob(job.publicJob.id);
        job.reject(new AppError(
          "WEB_RELAY_DISCONNECTED",
          "网页中继在生成过程中失去连接。为避免重复生成，任务不会自动转交给其他页面。",
          503,
        ));
      }
    }
  }

  private prunePresence(accountId: string, now: number): void {
    const workers = this.presenceByAccount.get(accountId);
    if (!workers) return;
    for (const [workerId, presence] of workers) {
      if (now - presence.lastSeenMs > this.options.presenceTimeoutMs) workers.delete(workerId);
    }
    if (workers.size === 0) this.presenceByAccount.delete(accountId);
  }

  private requireClaimedJob(accountId: string, workerId: string, jobId: string): InternalJob {
    const job = this.jobs.get(jobId);
    if (!job || job.accountId !== accountId) {
      throw new AppError("WEB_RELAY_JOB_NOT_FOUND", "网页中继任务不存在或已经结束", 404);
    }
    if (job.state !== "claimed" || job.claimedBy !== workerId) {
      throw new AppError("WEB_RELAY_JOB_NOT_CLAIMED", "该任务不属于当前网页中继", 409);
    }
    return job;
  }

  private removeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    clearTimeout(job.timer);
    this.jobs.delete(jobId);
    const order = this.jobOrderByAccount.get(job.accountId)?.filter((id) => id !== jobId) ?? [];
    if (order.length > 0) this.jobOrderByAccount.set(job.accountId, order);
    else this.jobOrderByAccount.delete(job.accountId);
  }

  private notifyPollers(accountId: string): void {
    const waiters = this.waitersByAccount.get(accountId);
    if (!waiters) return;
    for (const finish of [...waiters]) finish();
  }
}
