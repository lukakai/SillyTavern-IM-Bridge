import crypto from "node:crypto";
import { AppError } from "../../shared/errors/app-error";

export type WebRelayGenerationOperation = "send" | "regenerate";
export type WebRelayControlOperation =
  | "relay_refresh"
  | "settings_snapshot"
  | "settings_select_profile"
  | "settings_select_preset"
  | "settings_select_preset_profile"
  | "settings_select_model"
  | "settings_set_prompt_entries"
  | "settings_undo";
export type WebRelayOperation = WebRelayGenerationOperation | WebRelayControlOperation;

export interface GlobalPromptEntry {
  identifier: string;
  name: string;
  enabled: boolean;
  toggleable: boolean;
  empty: boolean;
}

export interface GlobalPresetProfile {
  id: string;
  label: string;
  active: boolean;
}

export interface GlobalPromptLayoutGroup {
  name: string;
  identifiers: string[];
}

export interface GlobalPromptLayoutSection {
  name: string;
  groups: GlobalPromptLayoutGroup[];
}

export interface GlobalSettingsSnapshot {
  currentProfile: string | null;
  profiles: string[];
  currentPreset: string | null;
  presets: string[];
  currentModel: string | null;
  prompts: GlobalPromptEntry[];
  presetProfiles: GlobalPresetProfile[];
  promptLayout: GlobalPromptLayoutSection[];
  undoAvailable: boolean;
  undoSavedAt: string | null;
}

export interface WebRelayJob {
  id: string;
  operation: WebRelayOperation;
  avatar: string;
  characterName: string;
  chatFile: string;
  text: string | null;
  modelOverride: string | null;
  controlPayload?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface WebRelayCompletion {
  messageIndex: number | null;
  chatId: string | null;
  characterAvatar: string | null;
  result?: unknown;
}

export interface WebRelayStatus {
  online: boolean;
  workerCount: number;
  lastSeenAt: string | null;
  relayVersion: string | null;
  pageUrl: string | null;
  pageInstanceId: string | null;
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
  pageInstanceId: string | null;
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
  pageInstanceId?: string | null;
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

function invalidSettingsResult(): AppError {
  return new AppError("WEB_RELAY_SETTINGS_INVALID", "网页中继返回了无效的全局设置状态", 502);
}

function nullableSettingsText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalidSettingsResult();
  const text = optionalText(value);
  if (text && text.length > 500) throw invalidSettingsResult();
  return text;
}

function settingsStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw invalidSettingsResult();
  return value.map((item) => {
    if (typeof item !== "string") throw invalidSettingsResult();
    const text = optionalText(item);
    if (!text || text.length > 500) throw invalidSettingsResult();
    return text;
  });
}

function decodePresetProfiles(value: unknown): GlobalPresetProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw invalidSettingsResult();
  return value.map((item): GlobalPresetProfile => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidSettingsResult();
    const profile = item as Record<string, unknown>;
    const id = optionalText(profile.id);
    const label = optionalText(profile.label);
    if (!id || !label || id.length > 200 || label.length > 200 || typeof profile.active !== "boolean") {
      throw invalidSettingsResult();
    }
    return { id, label, active: profile.active };
  });
}

function decodePromptLayout(value: unknown): GlobalPromptLayoutSection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw invalidSettingsResult();
  let groupCount = 0;
  let identifierCount = 0;
  return value.map((item): GlobalPromptLayoutSection => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidSettingsResult();
    const section = item as Record<string, unknown>;
    const name = optionalText(section.name);
    if (!name || name.length > 200 || !Array.isArray(section.groups)) throw invalidSettingsResult();
    groupCount += section.groups.length;
    if (groupCount > 250) throw invalidSettingsResult();
    const groups = section.groups.map((groupItem): GlobalPromptLayoutGroup => {
      if (!groupItem || typeof groupItem !== "object" || Array.isArray(groupItem)) throw invalidSettingsResult();
      const group = groupItem as Record<string, unknown>;
      const groupName = optionalText(group.name);
      if (!groupName || groupName.length > 200 || !Array.isArray(group.identifiers)) throw invalidSettingsResult();
      const identifiers = settingsStringList(group.identifiers, 2_000);
      identifierCount += identifiers.length;
      if (identifierCount > 2_000 || identifiers.some(identifier => identifier.length > 200)) {
        throw invalidSettingsResult();
      }
      return { name: groupName, identifiers };
    });
    return { name, groups };
  });
}

function normalizeControlPayload(
  operation: WebRelayControlOperation,
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const payload = value ?? {};
  if (operation === "relay_refresh" || operation === "settings_snapshot" || operation === "settings_undo") return {};
  if (operation === "settings_set_prompt_entries") {
    if (!Array.isArray(payload.identifiers) || payload.identifiers.length < 1 || payload.identifiers.length > 500) {
      throw new AppError("WEB_RELAY_SETTINGS_INVALID_PAYLOAD", "预设选项列表无效", 400);
    }
    const identifiers = [...new Set(payload.identifiers.map((item) => {
      if (typeof item !== "string") {
        throw new AppError("WEB_RELAY_SETTINGS_INVALID_PAYLOAD", "预设选项标识无效", 400);
      }
      const identifier = requiredText(item, "预设选项标识");
      if (identifier.length > 200) {
        throw new AppError("WEB_RELAY_SETTINGS_INVALID_PAYLOAD", "预设选项标识过长", 400);
      }
      return identifier;
    }))];
    if (typeof payload.enabled !== "boolean") {
      throw new AppError("WEB_RELAY_SETTINGS_INVALID_PAYLOAD", "预设选项开关状态无效", 400);
    }
    return { identifiers, enabled: payload.enabled };
  }
  const name = requiredText(typeof payload.name === "string" ? payload.name : "", "设置名称");
  if (name.length > 500) throw new AppError("WEB_RELAY_SETTINGS_INVALID_PAYLOAD", "设置名称过长", 400);
  return { name };
}

function decodeGlobalSettingsSnapshot(value: unknown): GlobalSettingsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidSettingsResult();
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.prompts) || input.prompts.length > 2_000 || typeof input.undoAvailable !== "boolean") {
    throw invalidSettingsResult();
  }
  const prompts = input.prompts.map((item): GlobalPromptEntry => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidSettingsResult();
    const prompt = item as Record<string, unknown>;
    const identifier = optionalText(prompt.identifier);
    const name = optionalText(prompt.name);
    if (
      !identifier
      || !name
      || typeof prompt.enabled !== "boolean"
      || typeof prompt.toggleable !== "boolean"
      || typeof prompt.empty !== "boolean"
      || identifier.length > 200
      || name.length > 500
    ) throw invalidSettingsResult();
    return {
      identifier,
      name,
      enabled: prompt.enabled,
      toggleable: prompt.toggleable,
      empty: prompt.empty,
    };
  });
  return {
    currentProfile: nullableSettingsText(input.currentProfile),
    profiles: settingsStringList(input.profiles, 500),
    currentPreset: nullableSettingsText(input.currentPreset),
    presets: settingsStringList(input.presets, 500),
    currentModel: nullableSettingsText(input.currentModel),
    prompts,
    presetProfiles: decodePresetProfiles(input.presetProfiles),
    promptLayout: decodePromptLayout(input.promptLayout),
    undoAvailable: input.undoAvailable,
    undoSavedAt: nullableSettingsText(input.undoSavedAt),
  };
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
      pageInstanceId: optionalText(identity.pageInstanceId),
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
      pageInstanceId: workers[0]?.pageInstanceId ?? null,
      pendingJobs: accountJobs.filter((job) => job.state === "pending").length,
      activeJobs: accountJobs.filter((job) => job.state === "claimed").length,
    };
  }

  public async execute(params: {
    accountId: string;
    operation: WebRelayGenerationOperation;
    avatar: string;
    characterName: string;
    chatFile: string;
    text?: string | null;
    modelOverride?: string | null;
  }): Promise<WebRelayCompletion> {
    const accountId = requiredText(params.accountId, "accountId");
    const publicJob: WebRelayJob = {
      id: crypto.randomUUID(),
      operation: params.operation,
      avatar: requiredText(params.avatar, "avatar"),
      characterName: requiredText(params.characterName, "characterName"),
      chatFile: requiredText(params.chatFile, "chatFile"),
      text: params.operation === "send" ? String(params.text ?? "") : null,
      modelOverride: optionalText(params.modelOverride),
      createdAt: "",
      expiresAt: "",
    };
    return this.enqueue(accountId, publicJob, this.options.jobTimeoutMs);
  }

  public async executeControl(params: {
    accountId: string;
    operation: WebRelayControlOperation;
    payload?: Record<string, unknown>;
  }): Promise<GlobalSettingsSnapshot> {
    const accountId = requiredText(params.accountId, "accountId");
    const status = this.requireOnline(accountId);
    if (status.pendingJobs > 0 || status.activeJobs > 0) {
      throw new AppError("WEB_RELAY_SETTINGS_BUSY", "酒馆网页正在处理其他任务，请完成后再打开或修改全局设置", 409);
    }
    const publicJob: WebRelayJob = {
      id: crypto.randomUUID(),
      operation: params.operation,
      avatar: "",
      characterName: "",
      chatFile: "",
      text: null,
      modelOverride: null,
      controlPayload: normalizeControlPayload(params.operation, params.payload),
      createdAt: "",
      expiresAt: "",
    };
    const completion = await this.enqueue(accountId, publicJob, Math.min(this.options.jobTimeoutMs, 120_000));
    return decodeGlobalSettingsSnapshot(completion.result);
  }

  /** Reload the authenticated ST page and wait until its new document reconnects. */
  public async refreshPage(accountId: string): Promise<void> {
    const account = requiredText(accountId, "accountId");
    const previous = this.requireOnline(account).pageInstanceId;
    const completion = await this.enqueue(account, {
      id: crypto.randomUUID(),
      operation: "relay_refresh",
      avatar: "",
      characterName: "",
      chatFile: "",
      text: null,
      modelOverride: null,
      controlPayload: {},
      createdAt: "",
      expiresAt: "",
    }, 30_000);
    void completion;

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = this.getStatus(account);
      if (current.online && current.pageInstanceId && current.pageInstanceId !== previous) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new AppError("WEB_RELAY_REFRESH_TIMEOUT", "酒馆网页刷新后未能重新上线", 504);
  }

  private enqueue(accountId: string, publicJob: WebRelayJob, timeoutMs: number): Promise<WebRelayCompletion> {
    this.requireOnline(accountId);
    const now = Date.now();
    publicJob.createdAt = new Date(now).toISOString();
    publicJob.expiresAt = new Date(now + timeoutMs).toISOString();
    const id = publicJob.id;
    return new Promise<WebRelayCompletion>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeJob(id);
        const isGeneration = publicJob.operation === "send" || publicJob.operation === "regenerate";
        reject(new AppError(
          "WEB_RELAY_TIMEOUT",
          `${isGeneration ? "网页完整模式生成" : "酒馆全局设置操作"}超时（${Math.round(timeoutMs / 1000)} 秒）`,
          504,
        ));
      }, timeoutMs);
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
      ...(completion.result !== undefined ? { result: completion.result } : {}),
    });
  }

  public fail(accountId: string, workerId: string, jobId: string, message: string): void {
    const job = this.requireClaimedJob(accountId, workerId, jobId);
    this.removeJob(jobId);
    const isGeneration = job.publicJob.operation === "send" || job.publicJob.operation === "regenerate";
    job.reject(new AppError(
      isGeneration ? "WEB_RELAY_GENERATE_FAILED" : "WEB_RELAY_SETTINGS_FAILED",
      `${isGeneration ? "酒馆网页生成" : "酒馆全局设置操作"}失败：${String(message || "未知错误").slice(0, 1000)}`,
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

  private requireOnline(accountId: string): WebRelayStatus {
    if (this.closed) throw new AppError("WEB_RELAY_CLOSED", "网页中继服务正在关闭", 503);
    const status = this.getStatus(accountId);
    if (!status.online) {
      throw new AppError(
        "WEB_RELAY_OFFLINE",
        "网页完整模式中继未在线。请启动 Mac mini 的专用 SillyTavern 网页中继。",
        503,
      );
    }
    return status;
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
