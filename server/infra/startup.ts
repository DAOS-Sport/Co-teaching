import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { coachUsers, venues } from "@shared/schema";
import { storage } from "../storage";
import { initializeSchoolSchema, getAvailableSchools } from "../multi-school-db";
import { env, validateConfig } from "../config/env";
import { featureFlags } from "../config/featureFlags";
import cron from "node-cron";
import { startBoss, getBoss } from "./queue/boss";
import { queues } from "./queue/queues";
import { lineGroups } from "../config/lineGroups";
import { startWeeklyPushWorkers } from "../modules/weeklyPush/weeklyPush.worker";
import { enqueueWeeklyPush } from "../modules/weeklyPush/weeklyPush.service";
import { setupWeeklyPushReconciliation } from "../modules/weeklyPush/weeklyPush.reconcile";

/**
 * Hard-fails the boot if required configuration is missing.
 * Called once from server/routes.ts before any module is wired up.
 */
export function assertBootConfig(): void {
  validateConfig();
}

/**
 * One-time, idempotent data fixes applied at boot.
 * Each block is wrapped so a failure in one fix does not stop others.
 */
export async function runStartupFixes(): Promise<void> {
  try {
    const result = await db
      .update(coachUsers)
      .set({ name: "林聖潤", linkedCoachName: "林聖潤" })
      .where(
        and(
          eq(coachUsers.name, "聖潤"),
          eq(coachUsers.id, "6b069216-12c8-4022-aa67-40de8a8c19f8")
        )
      )
      .returning({ id: coachUsers.id, name: coachUsers.name });
    if (result.length > 0) {
      console.log(
        `[Migration] Renamed coach "聖潤" → "林聖潤" (id: ${result[0].id})`
      );
    }
  } catch (err) {
    console.error("[Migration] runStartupFixes failed:", err);
  }

  try {
    const fixed = await db
      .update(venues)
      .set({ color: "blue" })
      .where(and(eq(venues.name, "士林國中"), eq(venues.color, "cyan")))
      .returning({ id: venues.id, name: venues.name });
    if (fixed.length > 0) {
      console.log(`[Migration] Fixed 士林國中 color: cyan → blue`);
    }
  } catch (err) {
    console.error("[Migration] Fix 士林國中 color failed:", err);
  }
}

/**
 * Initializes shared default rows (venues, time slots) and the per-school
 * Postgres schemas used by the multi-school feature.
 *
 * In production this throws on initialization failure (deployment must abort);
 * in development it logs and continues so the dev server still boots.
 */
export async function initializeAppData(): Promise<void> {
  await storage.initializeVenues();
  await storage.initializeTimeSlots();

  const tag = env.isDeployment ? "🚀 PRODUCTION" : "🛠️ DEVELOPMENT";

  if (!featureFlags.enableSchoolModule) {
    console.log(`${tag}: Multi-school module disabled via feature flag — skipping init`);
    return;
  }

  try {
    console.log(`${tag}: Initializing multi-school system...`);

    if (!env.databaseUrl) {
      throw new Error(
        "DATABASE_URL not configured - cannot initialize multi-school system"
      );
    }

    console.log(`${tag}: Creating schemas...`);
    for (const code of getAvailableSchools()) {
      await initializeSchoolSchema(code);
      console.log(`${tag}: ✅ school_${code} initialized`);
    }

    console.log(`${tag}: ✅ Multi-school system initialized successfully`);
  } catch (error) {
    console.error(`${tag}: ❌ Multi-school initialization FAILED:`, error);

    if (env.isDeployment && featureFlags.enableWeeklyPushWorker) {
      console.error(
        "🚨 CRITICAL: Production deployment failed to initialize database!"
      );
      console.error("🔧 Please check:");
      console.error("   1. DATABASE_URL environment variable is set");
      console.error("   2. Database is accessible");
      console.error("   3. Database has necessary permissions");
      throw error;
    } else {
      console.error(
        "⚠️ Development initialization error (continuing anyway):",
        error
      );
    }
  }
}

/**
 * Starts the pg-boss based weekly push pipeline (Task #23).
 *
 * Three independent gates:
 *   1. enableWeeklyPushQueue — boots pg-boss + ensures the queues
 *      exist so the admin enqueue endpoints have somewhere to publish.
 *   2. enableWeeklyPushWorker — registers the worker handlers so this
 *      process actually drains the queues. Disabled deployments can
 *      run the API without a worker if a separate process owns it.
 *   3. isDeployment + queue flag — only production schedules the
 *      Sunday cron so dev environments never auto-push real groups.
 *
 * Failures here only log; the rest of the app must keep serving.
 */
export async function startWeeklyPushQueue(): Promise<void> {
  if (!featureFlags.enableWeeklyPushQueue) {
    console.log("[boot] weekly push queue disabled — skipping");
    return;
  }

  try {
    await startBoss();
    const boss = getBoss();
    await boss.createQueue(queues.weeklyPush);
    await boss.createQueue(queues.weeklyPushRecipient);
    await boss.createQueue(queues.weeklyPushReport);
    console.log("[boot] pg-boss queues ready for weekly push");

    if (featureFlags.enableWeeklyPushWorker) {
      await startWeeklyPushWorkers();
      setupWeeklyPushReconciliation();
    } else {
      console.log("[boot] weekly push worker disabled — queue will accumulate");
    }

    // Cron only in production deployment. Dev never auto-fires.
    // We deliberately use node-cron here (NOT boss.schedule on the
    // weeklyPush queue) so the orchestrator queue keeps exactly one
    // worker — otherwise the cron router and the orchestrator handler
    // would race for jobs on the same queue.
    if (env.isDeployment) {
      // Production preconditions per task spec — refuse to register
      // the auto-cron when observability/destination envs are missing.
      // The admin can still trigger pushes manually via the REST API,
      // but un-monitored auto-fires are blocked so a silently broken
      // run can't go undetected for a week.
      const missing: string[] = [];
      if (!env.healthchecksWeeklyPushUrl || !env.healthchecksWeeklyPushEnabled) {
        missing.push("HEALTHCHECKS_WEEKLY_PUSH_URL");
      }
      if (!lineGroups.itGroupId) missing.push("LINE_IT_GROUP_ID");

      if (missing.length > 0) {
        console.warn(
          `[boot] weekly push cron NOT scheduled — missing required envs: ${missing.join(
            ", ",
          )}. Manual /api/admin/weekly-push/enqueue still works.`,
        );
      } else {
        cron.schedule(
          env.weeklyPushCron,
          () => {
            console.log("[boot] weekly push cron tick — enqueueing run");
            enqueueWeeklyPush({ triggerSource: "cron" }).catch((err) => {
              console.error("[boot] cron enqueue failed:", err);
            });
          },
          { timezone: env.weeklyPushTimezone },
        );
        console.log(
          `[boot] weekly push cron scheduled (${env.weeklyPushCron} ${env.weeklyPushTimezone})`,
        );
      }
    } else if (!env.isDeployment) {
      console.log(
        "[boot] dev environment — weekly push cron NOT scheduled (REPLIT_DEPLOYMENT!=1)",
      );
    } else {
      console.warn("[boot] weekly push cron NOT scheduled — worker is disabled");
    }
  } catch (err) {
    console.error("[boot] weekly push queue init failed:", err);
  }
}
