import type {
  AssignmentContext, AssignmentWarning, AvailabilityRow, CanonicalPatch,
  ConfirmationContext, MutationKind, ScheduleContextRow, SchedulePatch, ScheduleRow,
} from "./entities";
import { ScheduleMutationError } from "./entities";

/** Also used before transport patch preparation; the locked use case always rechecks. */
export function requireScheduleVersion(row: { version: number } | undefined, expected: unknown): number {
  if (!row) throw new ScheduleMutationError("SCHEDULE_NOT_FOUND");
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    throw new ScheduleMutationError("VERSION_REQUIRED");
  }
  if (row.version !== expected) throw new ScheduleMutationError("VERSION_CONFLICT");
  return expected;
}

/** Rules adapted from shared/scheduleRules.ts at c8301a6; no outer import. */
export const UNSTAFFED_COACH = "000";
export const isPlaceholderCoach = (value: unknown): boolean =>
  typeof value === "string" && value.trim() === UNSTAFFED_COACH;
export const isRealCoachName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !isPlaceholderCoach(value);
export const normalizeScheduleName = (value: string): string =>
  value.trim().replace(/\s+/g, "").toLocaleLowerCase();

export function sameCoach(first: unknown, second: unknown): boolean {
  if (!isRealCoachName(first) || !isRealCoachName(second)) return false;
  const a = normalizeScheduleName(first);
  const b = normalizeScheduleName(second);
  return !!a && !!b && a === b;
}

const isAssignableCoach = (value: unknown): value is string =>
  isRealCoachName(value) && value.trim() !== "缺";

export function isoWeekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function mondayOf(date: string): string {
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (isoWeekdayOf(date) - 1));
  return monday.toISOString().slice(0, 10);
}

/** Omitted and explicit undefined fields are absent writes; explicit null remains a write. */
export function definedPatch(patch: SchedulePatch): SchedulePatch {
  return {
    ...(patch.date === undefined ? {} : { date: patch.date }),
    ...(patch.venueId === undefined ? {} : { venueId: patch.venueId }),
    ...(patch.timeSlotId === undefined ? {} : { timeSlotId: patch.timeSlotId }),
    ...(patch.className === undefined ? {} : { className: patch.className }),
    ...(patch.coachName === undefined ? {} : { coachName: patch.coachName }),
    ...(patch.coachName2 === undefined ? {} : { coachName2: patch.coachName2 }),
    ...(patch.coach1IsTeaching === undefined ? {} : { coach1IsTeaching: patch.coach1IsTeaching }),
    ...(patch.coach2IsTeaching === undefined ? {} : { coach2IsTeaching: patch.coach2IsTeaching }),
    ...(patch.coachCount === undefined ? {} : { coachCount: patch.coachCount }),
    ...(patch.isClassLocked === undefined ? {} : { isClassLocked: patch.isClassLocked }),
    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
  };
}

export function preparePatch(before: ScheduleRow, requested: SchedulePatch): SchedulePatch {
  const patch = definedPatch(requested);
  const next = { ...before, ...patch };
  const hasCoach = (value: string | null): value is string =>
    typeof value === "string" && value.trim() !== "";
  if (!hasCoach(next.coachName) && hasCoach(next.coachName2)) {
    patch.coachName = next.coachName2;
    patch.coachName2 = null;
    patch.coach1IsTeaching = next.coach2IsTeaching;
    patch.coach2IsTeaching = false;
  }
  return patch;
}

export function newlyPlacedCoaches(before: ScheduleRow, after: ScheduleRow): string[] {
  const moved = before.date !== after.date || before.venueId !== after.venueId || before.timeSlotId !== after.timeSlotId;
  const prior = moved ? [] : [before.coachName, before.coachName2];
  return [after.coachName, after.coachName2]
    .filter(isAssignableCoach)
    .filter((coach) => !prior.some((existing) => sameCoach(existing, coach)))
    .map((coach) => coach.trim());
}

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const orderedJson = (a: object, b: object): number => lexical(JSON.stringify(a), JSON.stringify(b));

/** Old and new placements are serialized, including removals and moves between slots. */
export function placementLockKeys(before: ScheduleRow, after: ScheduleRow): string[] {
  return Array.from(new Set([before, after].flatMap((row) =>
    [row.coachName, row.coachName2].filter(isAssignableCoach)
      .map((coach) => `schedule-coach:${JSON.stringify([row.date, row.timeSlotId, normalizeScheduleName(coach)])}`),
  ))).sort(lexical);
}

function conflictRows(after: ScheduleRow, coaches: readonly string[], context: AssignmentContext): ScheduleContextRow[] {
  return context.sameDaySchedules
    .filter((row) => row.date === after.date && row.timeSlotId === after.timeSlotId
      && row.id !== after.id && row.venueId !== after.venueId
      && coaches.some((coach) => sameCoach(row.coachName, coach) || sameCoach(row.coachName2, coach)))
    .slice().sort((a, b) => lexical(a.id, b.id));
}

function relevantAvailability(coaches: readonly string[], context: AssignmentContext): AvailabilityRow[] {
  return context.weekAvailability.filter((slot) => coaches.some((coach) => sameCoach(slot.coachName, coach)))
    .map((slot) => ({ coachName: slot.coachName, dayOfWeek: slot.dayOfWeek, timeSlotOrder: slot.timeSlotOrder }))
    .sort(orderedJson);
}

/** Preserves cross-venue warnings, and no-availability-this-week means no warning. */
export function assignmentWarnings(after: ScheduleRow, coaches: readonly string[], context: AssignmentContext): AssignmentWarning[] {
  const warnings: AssignmentWarning[] = [];
  const clashes = conflictRows(after, coaches, context);
  const order = context.timeSlots.find((slot) => slot.id === after.timeSlotId)?.order ?? null;
  for (const coach of coaches) {
    const coachClashes = clashes.filter((row) => sameCoach(row.coachName, coach) || sameCoach(row.coachName2, coach));
    if (coachClashes.length > 0) {
      const places = coachClashes.map((row) => `${row.venue?.name || "其他場館"}（${row.className || "未命名班級"}）`);
      warnings.push({ code: "COACH_CONFLICT", coachName: coach, message: `${coach} 同時段已在 ${places.join("、")}` });
    }
    if (order !== null) {
      const filled = context.weekAvailability.filter((slot) => sameCoach(slot.coachName, coach));
      const covers = filled.some((slot) => slot.dayOfWeek === isoWeekdayOf(after.date) && slot.timeSlotOrder === order);
      if (filled.length > 0 && !covers) {
        warnings.push({ code: "COACH_UNAVAILABLE", coachName: coach, message: `${coach} 本週有填可排時段，但沒有填這個時段` });
      }
    }
  }
  return warnings;
}

export function confirmationContext(
  kind: MutationKind, before: ScheduleRow, patch: SchedulePatch, after: ScheduleRow,
  coaches: readonly string[], context: AssignmentContext, warnings: AssignmentWarning[],
): ConfirmationContext {
  const canonicalPatch: CanonicalPatch = {};
  for (const key of Object.keys(patch).sort()) {
    const value = patch[key as keyof SchedulePatch];
    if (value !== undefined) canonicalPatch[key] = value;
  }
  const slot = context.timeSlots.find((item) => item.id === after.timeSlotId);
  return {
    kind, scheduleId: before.id, version: before.version, canonicalPatch,
    warningSnapshot: {
      schedules: conflictRows(after, coaches, context).map((row) => ({
        id: row.id, date: row.date, venueId: row.venueId, timeSlotId: row.timeSlotId,
        className: row.className, coachName: row.coachName, coachName2: row.coachName2,
        version: row.version, isClassLocked: row.isClassLocked, venueName: row.venue?.name ?? null,
      })),
      timeSlot: slot ? { id: slot.id, order: slot.order } : null,
      availability: relevantAvailability(coaches, context),
    },
    warnings: warnings.map((warning) => ({ ...warning })),
  };
}
