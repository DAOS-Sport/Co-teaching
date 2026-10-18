/** Confirmed unstaffed slot; this code is never a person. */
export const UNSTAFFED_COACH = "000";
export const isPlaceholderCoach = (value: unknown): boolean =>
  typeof value === "string" && value.trim() === UNSTAFFED_COACH;

export const isRealCoachName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !isPlaceholderCoach(value);

export const normalizeScheduleName = (value: string): string =>
  value.trim().replace(/\s+/g, "").toLocaleLowerCase();

export const sameCoach = (first: unknown, second: unknown): boolean => {
  if (!isRealCoachName(first) || !isRealCoachName(second)) return false;
  const a = normalizeScheduleName(first);
  const b = normalizeScheduleName(second);
  return !!a && !!b && a === b;
};

export function statisticsPeriod(year: number, zeroBasedMonth: number) {
  const start = new Date(year, zeroBasedMonth, 16);
  const end = new Date(year, zeroBasedMonth + 1, 15);
  return { start, end };
}

export interface CoachSlots {
  coachName: string | null;
  coachName2: string | null;
  coach1IsTeaching: boolean;
  coach2IsTeaching: boolean;
}

export interface PromotedCoachSlots {
  coachName: string;
  coachName2: null;
  coach1IsTeaching: boolean;
  coach2IsTeaching: false;
}

const hasCoach = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Slot 2 only means something when slot 1 is filled. When slot 1 is empty
 * and slot 2 is not, the slot-2 coach moves up and keeps their teaching
 * flag. Returns `null` when the slots are already consistent so callers
 * can leave the row untouched.
 */
export function promoteCoachSlots(slots: CoachSlots): PromotedCoachSlots | null {
  if (hasCoach(slots.coachName) || !hasCoach(slots.coachName2)) return null;
  return {
    coachName: slots.coachName2,
    coachName2: null,
    coach1IsTeaching: slots.coach2IsTeaching,
    coach2IsTeaching: false,
  };
}

/** Monday-first weekday (1–7) of a YYYY-MM-DD date, read as a calendar date. */
export function isoWeekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Monday (YYYY-MM-DD) of the week containing a YYYY-MM-DD date. */
export function mondayOf(date: string): string {
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (isoWeekdayOf(date) - 1));
  return monday.toISOString().slice(0, 10);
}

/** "缺" marks a vacancy in legacy rows; like 000 it is never a person. */
const isAssignableCoach = (value: unknown): value is string =>
  isRealCoachName(value) && value.trim() !== "缺";

interface CoachPair {
  coachName?: string | null;
  coachName2?: string | null;
}

/**
 * Coaches on the row after a write who were not on it before. Moving a
 * coach between slots, or saving a row unchanged, places nobody new.
 */
export function newlyPlacedCoaches(before: CoachPair | null, after: CoachPair): string[] {
  const prior = [before?.coachName, before?.coachName2];
  return [after.coachName, after.coachName2]
    .filter(isAssignableCoach)
    .filter((coach) => !prior.some((existing) => sameCoach(existing, coach)))
    .map((coach) => coach.trim());
}

export type AssignmentWarningCode = "COACH_CONFLICT" | "COACH_UNAVAILABLE";

export interface AssignmentWarning {
  code: AssignmentWarningCode;
  coachName: string;
  message: string;
}

/**
 * Server-side version of the assignment page's checks. A conflict is the
 * same coach at another venue in the same period; two classes at the same
 * venue are not one. Names are compared whole, as the assignment page
 * does. A coach who filled no availability this week is not flagged.
 */
export function findAssignmentWarnings(input: {
  scheduleId: string | null;
  venueId: string;
  coaches: string[];
  sameSlotSchedules: {
    id: string;
    venueId: string;
    coachName: string | null;
    coachName2: string | null;
    className?: string | null;
    venue?: { name?: string | null } | null;
  }[];
  weekAvailability: { coachName: string; dayOfWeek: number; timeSlotOrder: number }[];
  dayOfWeek: number;
  timeSlotOrder: number | null;
}): AssignmentWarning[] {
  const warnings: AssignmentWarning[] = [];
  for (const coach of input.coaches) {
    const clashes = input.sameSlotSchedules.filter(
      (row) =>
        row.id !== input.scheduleId &&
        row.venueId !== input.venueId &&
        (sameCoach(row.coachName, coach) || sameCoach(row.coachName2, coach)),
    );
    if (clashes.length > 0) {
      const places = clashes.map((row) => `${row.venue?.name || "其他場館"}（${row.className || "未命名班級"}）`);
      warnings.push({ code: "COACH_CONFLICT", coachName: coach, message: `${coach} 同時段已在 ${places.join("、")}` });
    }
    if (input.timeSlotOrder !== null) {
      const filled = input.weekAvailability.filter((slot) => sameCoach(slot.coachName, coach));
      const coversSlot = filled.some(
        (slot) => slot.dayOfWeek === input.dayOfWeek && slot.timeSlotOrder === input.timeSlotOrder,
      );
      if (filled.length > 0 && !coversSlot) {
        warnings.push({ code: "COACH_UNAVAILABLE", coachName: coach, message: `${coach} 本週有填可排時段，但沒有填這個時段` });
      }
    }
  }
  return warnings;
}

/** Warnings whose code the caller has not listed in `confirmWarnings`. */
export function unconfirmedWarnings(warnings: AssignmentWarning[], confirmed: unknown): AssignmentWarning[] {
  const accepted = new Set(Array.isArray(confirmed) ? confirmed.filter((code) => typeof code === "string") : []);
  return warnings.filter((warning) => !accepted.has(warning.code));
}
