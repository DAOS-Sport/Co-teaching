import { storage } from "../storage";
import {
  findAssignmentWarnings,
  isoWeekdayOf,
  mondayOf,
  newlyPlacedCoaches,
  unconfirmedWarnings,
  type AssignmentWarning,
} from "@shared/scheduleRules";

interface CoachPair {
  coachName?: string | null;
  coachName2?: string | null;
}

export const SCHEDULE_LOCKED = {
  code: "SCHEDULE_LOCKED",
  message: "課表已鎖定，請先解鎖該週才能新增或修改課程名稱",
} as const;

/** Any locked class at the venue on that date locks the day (same rule as import). */
export async function isVenueDateLocked(venueId: string, date: string): Promise<boolean> {
  const rows = await storage.getSchedulesByDate(date);
  return rows.some((row) => row.venueId === venueId && row.isClassLocked);
}

/**
 * Conflict / availability warnings for coaches this write newly places,
 * minus the codes the caller already confirmed. Reads nothing when no
 * coach is newly placed.
 */
export async function pendingAssignmentWarnings(input: {
  scheduleId: string | null;
  date: string;
  timeSlotId: string;
  before: CoachPair | null;
  after: CoachPair;
  confirmed: unknown;
}): Promise<AssignmentWarning[]> {
  const coaches = newlyPlacedCoaches(input.before, input.after);
  if (coaches.length === 0) return [];
  const [sameDay, timeSlots, weekAvailability] = await Promise.all([
    storage.getSchedulesByDate(input.date),
    storage.getTimeSlots(),
    storage.getCoachAvailabilityByWeek(mondayOf(input.date)),
  ]);
  const warnings = findAssignmentWarnings({
    scheduleId: input.scheduleId,
    coaches,
    sameSlotSchedules: sameDay.filter((row) => row.timeSlotId === input.timeSlotId),
    weekAvailability,
    dayOfWeek: isoWeekdayOf(input.date),
    timeSlotOrder: timeSlots.find((slot) => slot.id === input.timeSlotId)?.order ?? null,
  });
  return unconfirmedWarnings(warnings, input.confirmed);
}

export const confirmRequired = (warnings: AssignmentWarning[]) => ({
  code: "CONFIRM_REQUIRED",
  message: `需要確認：${warnings.map((warning) => warning.message).join("；")}`,
  warnings,
});
