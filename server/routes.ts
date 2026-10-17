/**
 * Thin entrypoint that wires the Express app together.
 *
 * Per-feature handlers live in `server/modules/*.routes.ts` and are
 * registered through `registerAllModules`. Maintenance and background workers
 * are explicit operations; the web entrypoint never starts them.
 *
 * Anything you would otherwise add inline here should instead live in
 * its own module under `server/modules/` and be wired via the registry.
 */
import type { Express } from "express";
import { createServer, type Server } from "http";

import { setupAuth } from "./replitAuth";
import { assertBootConfig } from "./infra/startup";
import { registerAllModules } from "./modules/_registry";
import { registerRemoteMcpRoutes } from "./mcp/remoteMcp.routes";
import { registerSchedulingMcpRoutes } from "./mcp/schedulingMcp.routes";
import { registerSchedulingOAuthRoutes } from "./mcp/schedulingOAuth";
import { registerNotificationWakeRoutes } from './modules/notificationWake/wake.routes';

export async function registerRoutes(app: Express): Promise<Server> {
  // 0. Fail fast on missing config (esp. ADMIN_PASSWORD in production)
  assertBootConfig();

  // This OIDC-only endpoint must not read/touch a browser session before rejecting a JWT.
  registerNotificationWakeRoutes(app);

  // 1. Auth middleware (sessions + Replit OIDC)
  await setupAuth(app);

  // 4. All feature modules
  registerAllModules(app);
  registerRemoteMcpRoutes(app);
  registerSchedulingOAuthRoutes(app);
  registerSchedulingMcpRoutes(app);

  // No maintenance, seeding, migrations, queue startup, timers or data retention
  // are registered by the web process, even when old feature flags are enabled.
  return createServer(app);
}
