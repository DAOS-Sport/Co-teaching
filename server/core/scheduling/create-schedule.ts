import { ScheduleMutationError, type ScheduleMutationInput, type SchedulePatch, type ScheduleRow } from "./entities";
import type { ScheduleUseCaseDependencies } from "./ports";
import { assignmentWarnings, confirmationContext, mondayOf, newlyPlacedCoaches, placementLockKeys, preparePatch, sameCoach } from "./policies";

export type ScheduleCreateValues = SchedulePatch & { date: string; venueId: string; timeSlotId: string };
type Dependencies = Omit<ScheduleUseCaseDependencies, "repository"> & {
  repository: ScheduleUseCaseDependencies["repository"] & { create(values: ScheduleCreateValues): Promise<ScheduleRow> };
};
export function createScheduleCreationUseCase(deps: Dependencies) {
  return (input: Omit<ScheduleMutationInput, "scheduleId" | "expectedVersion" | "patch"> & { values: ScheduleCreateValues }) => deps.unitOfWork.run(async () => {
    const values = input.values;
    const before: ScheduleRow = { id: `create:${JSON.stringify([values.date, values.venueId, values.timeSlotId, values.className])}`,
      date: values.date, venueId: values.venueId, timeSlotId: values.timeSlotId, version: 0, className: null,
      coachName: null, coachName2: null, coachCount: 1, coach1IsTeaching: true, coach2IsTeaching: false,
      isClassLocked: false, notes: null, createdAt: null, updatedAt: null };
    const patch = preparePatch(before, values), after = { ...before, ...patch };
    await deps.locks.acquire(placementLockKeys(before, after));
    const context = await deps.repository.loadAssignmentContext({ date: after.date, venueId: after.venueId, timeSlotId: after.timeSlotId, weekStart: mondayOf(after.date) });
    if (context.sameDaySchedules.some(s => s.venueId === after.venueId && s.date === after.date && s.isClassLocked)) throw new ScheduleMutationError("SCHEDULE_LOCKED");
    if (sameCoach(after.coachName, after.coachName2)) throw new ScheduleMutationError("DUPLICATE_COACH");
    const placed = newlyPlacedCoaches(before, after), warnings = assignmentWarnings(after, placed, context);
    const accepted = new Set(Array.isArray(input.confirmWarnings) ? input.confirmWarnings : []);
    if (warnings.length || input.confirmationToken || accepted.size) {
      const signed = confirmationContext("createSchedule", before, patch, after, placed, context, warnings);
      if (!input.confirmationToken || !await deps.confirmation.verify(input.confirmationToken, signed) || warnings.some(w => !accepted.has(w.code))) {
        throw new ScheduleMutationError("CONFIRM_REQUIRED", { warnings, confirmationToken: await deps.confirmation.issue(signed) });
      }
    }
    const saved = await deps.repository.create({ ...values, ...patch });
    await deps.audit.record({ kind: "createSchedule", context: input.auditContext, before, after: saved });
    return saved;
  });
}
