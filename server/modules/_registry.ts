/**
 * Central registry — wires every per-feature module into the Express app
 * in a known, deterministic order.
 *
 * Modules are intentionally loose-coupled: each `register*Routes` only
 * touches its own URL space and the shared `storage` façade. New modules
 * should be added here, never inlined into routes.ts.
 *
 * Optional modules (school, notify, ragic) are gated behind feature
 * flags so individual deployments can turn them off without code changes.
 */
import type { Express } from "express";

import { registerAuthRoutes } from "./auth.routes";
import { registerVenueRoutes } from "./venue.routes";
import { registerTimeSlotRoutes } from "./timeSlot.routes";
import { registerScheduleRoutes } from "./schedule.routes";
import { registerCoachRoutes } from "./coach.routes";
import { registerCoachPortalRoutes } from "./coachPortal.routes";
import { registerCoachAdminRoutes } from "./coachAdmin.routes";
import { registerNotifyRoutes } from "./notify.routes";
import { registerRagicRoutes } from "./ragic.routes";
import { registerSchoolRoutes } from "./school.routes";
import { registerDiagnosticRoutes } from "./diagnostic.routes";
import { registerWeeklyPushRoutes } from "./weeklyPush/weeklyPush.routes";
import { registerItGovernanceRoutes } from "./itGovernance.routes";
import { featureFlags } from "../config/featureFlags";

export function registerAllModules(app: Express): void {
  // Auth must come first so downstream modules can rely on req.user etc.
  registerAuthRoutes(app);

  // Always-on domain modules
  registerVenueRoutes(app);
  registerTimeSlotRoutes(app);
  registerScheduleRoutes(app);
  registerCoachRoutes(app);
  registerCoachPortalRoutes(app);
  registerCoachAdminRoutes(app);

  // Feature-flagged modules
  if (featureFlags.enableLineNotify) {
    registerNotifyRoutes(app);
  } else {
    console.log("[modules] LINE notify module disabled via feature flag");
  }

  if (featureFlags.enableRagicSync) {
    registerRagicRoutes(app);
  } else {
    console.log("[modules] Ragic sync module disabled via feature flag");
  }

  if (featureFlags.enableSchoolModule) {
    registerSchoolRoutes(app);
  } else {
    console.log("[modules] Multi-school module disabled via feature flag");
  }

  // Task #23 — weekly push admin endpoints. The routes themselves are
  // safe to register even when the queue is off (they only enqueue
  // through pg-boss which is started elsewhere), but we honour the
  // flag so a disabled deployment can't accidentally trigger pushes.
  if (featureFlags.enableWeeklyPushQueue) {
    registerWeeklyPushRoutes(app);
  } else {
    console.log("[modules] Weekly push queue disabled via feature flag");
  }

  // Operational endpoints
  registerDiagnosticRoutes(app);
  registerItGovernanceRoutes(app);
}
