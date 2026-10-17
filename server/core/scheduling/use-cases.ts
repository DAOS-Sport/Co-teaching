import { ScheduleMutationError, type MutationKind, type ScheduleMutationInput } from "./entities";
import type { ScheduleUseCaseDependencies } from "./ports";
import {
  assignmentWarnings, confirmationContext, definedPatch, mondayOf,
  newlyPlacedCoaches, placementLockKeys, preparePatch, sameCoach, requireScheduleVersion,
} from "./policies";

/** Shared mutation policy for migrated update/assign callers; other write paths are outside A1. */
export function createScheduleUseCases(deps: ScheduleUseCaseDependencies) {
  async function mutate(kind: MutationKind, input: ScheduleMutationInput) {
    const requested = definedPatch(input.patch);
    const expectedVersion = input.expectedVersion;
    const token = input.confirmationToken;
    const accepted = new Set(Array.isArray(input.confirmWarnings)
      ? input.confirmWarnings.filter((code): code is string => typeof code === "string") : []);
    const auditContext = { ...input.auditContext };

    return deps.unitOfWork.run(async () => {
      await deps.locks.acquire([`schedule:${input.scheduleId}`]);
      const before = await deps.repository.getById(input.scheduleId);
      const version = requireScheduleVersion(before, expectedVersion);
      if (!before) throw new ScheduleMutationError("SCHEDULE_NOT_FOUND");

      const patch = preparePatch(before, requested);
      const after = { ...before, ...patch };
      await deps.locks.acquire(placementLockKeys(before, after));
      const context = await deps.repository.loadAssignmentContext({
        date: after.date, venueId: after.venueId, timeSlotId: after.timeSlotId, weekStart: mondayOf(after.date),
      });

      if (sameCoach(after.coachName, after.coachName2)) throw new ScheduleMutationError("DUPLICATE_COACH");
      if (before.isClassLocked && patch.className !== undefined && patch.className !== before.className) {
        throw new ScheduleMutationError("SCHEDULE_LOCKED");
      }

      const coaches = newlyPlacedCoaches(before, after);
      const warnings = assignmentWarnings(after, coaches, context);
      const needsConfirmation = warnings.length > 0 || !!token || accepted.size > 0;
      if (needsConfirmation) {
        const signedContext = confirmationContext(kind, before, patch, after, coaches, context, warnings);
        const validToken = !!token && await deps.confirmation.verify(token, signedContext);
        const allWarningsAccepted = warnings.every((warning) => accepted.has(warning.code));
        if (!validToken || !allWarningsAccepted) {
          throw new ScheduleMutationError("CONFIRM_REQUIRED", {
            warnings, confirmationToken: await deps.confirmation.issue(signedContext),
          });
        }
      }

      const saved = await deps.repository.update(before.id, patch, version);
      await deps.audit.record({ kind, context: auditContext, before, after: saved });
      return saved;
    });
  }

  return {
    updateSchedule: (input: ScheduleMutationInput) => mutate("updateSchedule", input),
    assignCoach: (input: ScheduleMutationInput) => mutate("assignCoach", input),
  };
}
