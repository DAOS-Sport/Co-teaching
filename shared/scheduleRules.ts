export const normalizeScheduleName = (value: string): string =>
  value.trim().replace(/\s+/g, "").toLocaleLowerCase();

export const sameCoach = (first: unknown, second: unknown): boolean => {
  if (typeof first !== "string" || typeof second !== "string") return false;
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