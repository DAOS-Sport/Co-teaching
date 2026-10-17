import { startNotificationRuntime } from "./queue/runtime";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { coachUsers, venues } from "@shared/schema";
import { storage } from "../storage";
import { initializeSchoolSchema, getAvailableSchools } from "../multi-school-db";
import { env, validateConfig } from "../config/env";
import { featureFlags } from "../config/featureFlags";
import { assertMaintenanceInvocation, type MaintenanceInvocation } from "./startup-policy";

/**
 * Hard-fails the boot if required configuration is missing.
 * Called once from server/routes.ts before any module is wired up.
 */
export function assertBootConfig(): void {
  validateConfig();
}

/**
 * Legacy data repairs available only through an explicit maintenance invocation.
 * Failures propagate to the explicit caller; web boot never calls this function.
 */
export async function runStartupFixes(invocation: MaintenanceInvocation): Promise<void> {
  assertMaintenanceInvocation(invocation);
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
    throw err;
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
    throw err;
  }
}

/**
 * Initializes shared default rows (venues, time slots) and the per-school
 * Postgres schemas used by the multi-school feature.
 *
 * In production this throws on initialization failure (deployment must abort);
 * in development it logs and continues so the dev server still boots.
 */
export async function initializeAppData(invocation: MaintenanceInvocation): Promise<void> {
  assertMaintenanceInvocation(invocation);
  await storage.initializeVenues();
  await storage.initializeTimeSlots();

  const tag = env.isDeployment ? "🚀 PRODUCTION" : "🛠️ DEVELOPMENT";

  if (!featureFlags.enableSchoolModule) {
    console.log(`${tag}: Multi-school module disabled via feature flag — skipping init`);
    return;
  }

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
}

/** Explicit legacy worker entry; scheduling is handled only by pg-boss. */
export async function startWeeklyPushQueue(invocation: MaintenanceInvocation): Promise<void> {
  assertMaintenanceInvocation(invocation);
  if (!featureFlags.enableWeeklyPushQueue) return;
  if (!featureFlags.enableWeeklyPushWorker) throw new Error("NOTIFICATION_WORKER_REQUIRED");
  await startNotificationRuntime({ schedules: false });
}
