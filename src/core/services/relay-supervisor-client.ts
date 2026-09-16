import { AppError } from "../../shared/errors/app-error";

export type RelaySupervisorAction = "start" | "stop" | "restart" | "refresh";

export interface RelaySupervisorStatus {
  configured: boolean;
  reachable: boolean;
  state: "running" | "stopped" | "unknown";
  label: string | null;
  pid: number | null;
  message: string | null;
}

interface RelaySupervisorClientOptions {
  baseUrl: string | null;
  token: string | null;
  timeoutMs?: number;
}

function optionalText(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseStatus(value: unknown, configured: boolean): RelaySupervisorStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("RELAY_SUPERVISOR_INVALID_RESPONSE", "Mac mini 中继控制器返回了无效状态", 502);
  }
  const input = value as Record<string, unknown>;
  const state = input.state === "running" || input.state === "stopped" || input.state === "unknown"
    ? input.state
    : "unknown";
  return {
    configured,
    reachable: input.reachable !== false,
    state,
    label: optionalText(typeof input.label === "string" ? input.label : null),
    pid: Number.isInteger(input.pid) ? Number(input.pid) : null,
    message: optionalText(typeof input.message === "string" ? input.message : null),
  };
}

/** Client for the Mac mini's fixed-action launchd controller. */
export class RelaySupervisorClient {
  private readonly baseUrl: string | null;
  private readonly token: string | null;
  private readonly timeoutMs: number;

  public constructor(options: RelaySupervisorClientOptions) {
    this.baseUrl = optionalText(options.baseUrl)?.replace(/\/+$/, "") ?? null;
    this.token = optionalText(options.token);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
  }

  public isConfigured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  public async getStatus(): Promise<RelaySupervisorStatus> {
    if (!this.isConfigured()) {
      return { configured: false, reachable: false, state: "unknown", label: null, pid: null, message: "未配置 Mac mini 控制器" };
    }
    return parseStatus(await this.request("/v1/status"), true);
  }

  public async execute(action: RelaySupervisorAction): Promise<RelaySupervisorStatus> {
    if (!this.isConfigured()) {
      throw new AppError("RELAY_SUPERVISOR_NOT_CONFIGURED", "Mac mini 中继控制器尚未配置", 503);
    }
    return parseStatus(await this.request("/v1/relay", { action }), true);
  }

  private async request(pathname: string, body?: Record<string, string>): Promise<unknown> {
    let target: URL;
    try {
      target = new URL(pathname, `${this.baseUrl}/`);
    } catch {
      throw new AppError("RELAY_SUPERVISOR_INVALID_URL", "Mac mini 控制器地址无效", 500);
    }
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
      throw new AppError("RELAY_SUPERVISOR_INVALID_URL", "Mac mini 控制器地址必须是无账号密码的 http 或 https 地址", 500);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(target, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }
      if (!response.ok) {
        const detail = parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error ?? "")
          : "";
        throw new AppError("RELAY_SUPERVISOR_REQUEST_FAILED", `Mac mini 中继控制器请求失败：${detail || response.status}`, 502);
      }
      return parsed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError("RELAY_SUPERVISOR_UNREACHABLE", `无法连接 Mac mini 中继控制器：${message}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }
}
