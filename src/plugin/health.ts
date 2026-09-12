import type { AppServices } from "./build-services";

type CheckStatus = "ok" | "degraded" | "error";

export interface HealthSnapshot {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    database: { status: CheckStatus };
    telegram: {
      status: CheckStatus;
      configured: number;
      running: number;
      starting: number;
      errors: number;
    };
    webRelay: {
      status: CheckStatus;
      onlineAccounts: number;
      workers: number;
      pendingJobs: number;
      activeJobs: number;
    };
  };
}

export function buildHealthSnapshot(services: AppServices): HealthSnapshot {
  let databaseStatus: CheckStatus = "ok";
  let configs: ReturnType<AppServices["repositories"]["accountConfigRepository"]["listAll"]> = [];
  try {
    services.repositories.db.prepare("SELECT 1 AS ok").get();
    configs = services.repositories.accountConfigRepository.listAll();
  } catch (error) {
    databaseStatus = "error";
    console.error(JSON.stringify({
      scope: "health",
      event: "database_check_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
  }

  const enabledConfigs = configs.filter((config) => config.botEnabled && Boolean(config.telegramBotToken));
  const botEntries = services.botManager.list();
  const running = botEntries.filter((entry) => entry.status === "running").length;
  const starting = botEntries.filter((entry) => entry.status === "starting").length;
  const errors = botEntries.filter((entry) => entry.status === "error").length;
  const missing = Math.max(0, enabledConfigs.length - running - starting - errors);
  const telegramStatus: CheckStatus = errors > 0 || missing > 0 ? "degraded" : "ok";

  let relayCheckFailed = false;
  const relayStatuses = configs.flatMap((config) => {
    try {
      return [services.webRelayService.getStatus(config.accountId)];
    } catch (error) {
      relayCheckFailed = true;
      console.error(JSON.stringify({
        scope: "health",
        event: "web_relay_check_failed",
        accountId: config.accountId,
        message: error instanceof Error ? error.message : String(error),
      }));
      return [];
    }
  });
  const onlineAccounts = relayStatuses.filter((status) => status.online).length;
  const workers = relayStatuses.reduce((sum, status) => sum + status.workerCount, 0);
  const pendingJobs = relayStatuses.reduce((sum, status) => sum + status.pendingJobs, 0);
  const activeJobs = relayStatuses.reduce((sum, status) => sum + status.activeJobs, 0);
  const strandedRelayJobs = onlineAccounts === 0 && pendingJobs + activeJobs > 0;
  const webRelayStatus: CheckStatus = relayCheckFailed || strandedRelayJobs ? "degraded" : "ok";

  const status = databaseStatus === "error"
    ? "unhealthy"
    : telegramStatus === "degraded" || webRelayStatus === "degraded"
      ? "degraded"
      : "healthy";

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      database: { status: databaseStatus },
      telegram: {
        status: telegramStatus,
        configured: enabledConfigs.length,
        running,
        starting,
        errors,
      },
      webRelay: {
        status: webRelayStatus,
        onlineAccounts,
        workers,
        pendingJobs,
        activeJobs,
      },
    },
  };
}

export function renderHealthSnapshot(snapshot: HealthSnapshot): string {
  const overall = snapshot.status === "healthy" ? "🟢 正常" : snapshot.status === "degraded" ? "🟡 部分异常" : "🔴 不可用";
  const database = snapshot.checks.database.status === "ok" ? "🟢 正常" : "🔴 异常";
  const telegram = snapshot.checks.telegram;
  const relay = snapshot.checks.webRelay;
  return [
    `系统状态：${overall}`,
    `数据库：${database}`,
    `Telegram Bot：${telegram.running}/${telegram.configured} 运行中${telegram.starting ? `，${telegram.starting} 个启动中` : ""}${telegram.errors ? `，${telegram.errors} 个错误` : ""}`,
    `网页中继：${relay.onlineAccounts} 个账号在线，${relay.workers} 个页面${relay.pendingJobs + relay.activeJobs ? `，${relay.pendingJobs} 个等待 / ${relay.activeJobs} 个执行中` : ""}`,
    `进程运行：${snapshot.uptimeSeconds} 秒`,
  ].join("\n");
}
