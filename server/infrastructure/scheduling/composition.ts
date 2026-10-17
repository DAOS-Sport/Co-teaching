import type { AuditAction } from "@shared/auditActions";
import { storage } from "../../storage";
import { recordAudit, scheduleContext, scheduleFields } from "../../shared/audit";
import { env } from "../../config/env";
import { createScheduleUseCases as createCoreUseCases } from "../../core/scheduling/use-cases";
import { createScheduleCreationUseCase } from "../../core/scheduling/create-schedule";
import type { ScheduleAuditEntry } from "../../core/scheduling/entities";
import { inScheduleTransaction, schedulingLocks } from "./transaction";
export { setSchedulingLocksForTest } from "./transaction";
import { StorageScheduleMutationRepository } from "../../adapters/repositories/schedule-mutation.repository";
import { createScheduleConfirmation } from "../../adapters/services/schedule-confirmation";

export function createSchedulingUseCases(context: { actor: string; requestId: string | null; action: AuditAction }) {
  const dependencies = {
    repository: new StorageScheduleMutationRepository(storage),
    unitOfWork: { run: inScheduleTransaction },
    locks: schedulingLocks(),
    confirmation: createScheduleConfirmation(env.adminPassword),
    audit: {
      async record(entry: ScheduleAuditEntry) {
        await recordAudit({ actor: context.actor, requestId: context.requestId, action: context.action,
          entity: "schedule", entityId: entry.after.id,
          before: entry.kind === "createSchedule" ? null : scheduleFields(entry.before), after: scheduleFields(entry.after),
          reason: entry.context.reason ?? await scheduleContext(entry.kind === "createSchedule" ? entry.after : entry.before) });
      },
    },
  };
  return { ...createCoreUseCases(dependencies), createSchedule: createScheduleCreationUseCase(dependencies) };
}
