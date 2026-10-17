import { sql } from "drizzle-orm";
import type { AuditAction } from "@shared/auditActions";
import { storage } from "../../storage";
import { currentDb, inTransaction } from "../../shared/dbContext";
import { recordAudit, scheduleContext, scheduleFields } from "../../shared/audit";
import { env } from "../../config/env";
import { createScheduleUseCases as createCoreUseCases } from "../../core/scheduling/use-cases";
import type { ScheduleLocks } from "../../core/scheduling/ports";
import { StorageScheduleMutationRepository } from "../../adapters/repositories/schedule-mutation.repository";
import { createScheduleConfirmation } from "../../adapters/services/schedule-confirmation";

const postgresLocks: ScheduleLocks = {
  async acquire(keys) {
    for (const key of keys) await currentDb().execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  },
};
let testLocks: ScheduleLocks | null = null;
/** Explicit in-process test seam; no environment flag disables production locks. */
export function setSchedulingLocksForTest(locks: ScheduleLocks | null): void { testLocks = locks; }

export function createSchedulingUseCases(context: { actor: string; requestId: string | null; action: AuditAction }) {
  return createCoreUseCases({
    repository: new StorageScheduleMutationRepository(storage),
    unitOfWork: { run: inTransaction },
    locks: testLocks ?? postgresLocks,
    confirmation: createScheduleConfirmation(env.adminPassword),
    audit: {
      async record(entry) {
        await recordAudit({ actor: context.actor, requestId: context.requestId, action: context.action,
          entity: "schedule", entityId: entry.after.id,
          before: scheduleFields(entry.before), after: scheduleFields(entry.after),
          reason: entry.context.reason ?? await scheduleContext(entry.before) });
      },
    },
  });
}
