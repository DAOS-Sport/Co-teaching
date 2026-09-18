/**
 * Thin entrypoint that wires the Express app together.
 *
 * Per-feature handlers live in `server/modules/*.routes.ts` and are
 * registered through `registerAllModules`. Boot-time data fixes and
 * multi-school schema setup live in `server/infra/startup.ts`.
 *
 * Anything you would otherwise add inline here should instead live in
 * its own module under `server/modules/` and be wired via the registry.
 */
import type { Express } from "express";
import { createServer, type Server } from "http";

import { setupAuth } from "./replitAuth";
import {
  assertBootConfig,
  runStartupFixes,
  initializeAppData,
} from "./infra/startup";
import { registerAllModules } from "./modules/_registry";
import { setupDailyNotificationCron } from "./line-notify";
import { setupRagicSyncCron } from "./ragic";
import { startWeeklyPushQueue } from "./infra/startup";
import { featureFlags } from "./config/featureFlags";
import { setupReportCleanupCron } from "./modules/weeklyPush/weeklyPush.cleanup";
import { registerRemoteMcpRoutes } from "./mcp/remoteMcp.routes";

export async function registerRoutes(app: Express): Promise<Server> {
  // 0. Fail fast on missing config (esp. ADMIN_PASSWORD in production)
  assertBootConfig();

  // 1. Auth middleware (sessions + Replit OIDC)
  await setupAuth(app);

  // 2. One-time data fixes (idempotent)
  await runStartupFixes();

  // 3. Default rows + multi-school schemas
  await initializeAppData();

  // 4. All feature modules
  registerAllModules(app);
  registerRemoteMcpRoutes(app);

  // 5. Background jobs (gated by feature flags)
  if (featureFlags.enableLineNotify) {
    // Weekly delivery is exclusively owned by the pg-boss pipeline.
    // The legacy weekly cron must never be registered, even when the
    // new queue is disabled. Daily reminders remain on the legacy path.
    setupDailyNotificationCron();
  }
  if (featureFlags.enableRagicSync) {
    setupRagicSyncCron();
  }

  // 6. Weekly push queue + worker + cron (Task #23). All gated.
  await startWeeklyPushQueue();

  // 7. Report cleanup cron — only when weekly push is enabled
  if (featureFlags.enableWeeklyPushQueue) {
    setupReportCleanupCron();
  }

  return createServer(app);
}
