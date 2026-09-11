import type { Router } from "express";
import { buildServices, type AppServices } from "./build-services";
import { registerRoutes } from "./routes";

export const info = {
  id: "st-im-bridge",
  name: "SillyTavern IM Bridge",
  description: "Bridge SillyTavern chats to instant messaging channels (Telegram).",
  author: "Rin",
  version: "0.1.0",
} as const;

let services: AppServices | null = null;

export async function init(router: Router): Promise<void> {
  if (services) {
    try { await exit(); } catch (err) { console.error("[st-im-bridge] re-init exit failed", err); }
  }
  services = buildServices();
  registerRoutes(router, services);
  void services.botManager.autostartAll().catch((err) => {
    console.error("[st-im-bridge] autostart failed", err);
  });
  console.log("[st-im-bridge] init complete");
}

export async function exit(): Promise<void> {
  const current = services;
  services = null;
  if (!current) return;
  try { await current.sseRegistry.drainAll(2000); } catch (err) { console.error("[st-im-bridge] sse drain failed", err); }
  try { await current.botManager.stopAll(); } catch (err) { console.error("[st-im-bridge] stop bots failed", err); }
  try { current.webRelayService.close(); } catch (err) { console.error("[st-im-bridge] close web relay failed", err); }
  try { current.repositories.close(); } catch (err) { console.error("[st-im-bridge] db close failed", err); }
  console.log("[st-im-bridge] exited");
}

const plugin = { info, init, exit };
export default plugin;
module.exports = plugin;
module.exports.default = plugin;
module.exports.info = info;
module.exports.init = init;
module.exports.exit = exit;
