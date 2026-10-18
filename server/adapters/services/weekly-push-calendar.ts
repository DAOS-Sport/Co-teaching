import { addDays, format, startOfWeek } from "date-fns";

/** Preserve the existing local-calendar week heuristic; timezone policy is unchanged. */
export function computeDefaultWeekRange(now: Date = new Date()): {
  weekStartDate: string;
  weekEndDate: string;
} {
  const monday = startOfWeek(addDays(now, 1), { weekStartsOn: 1 });
  const sunday = addDays(monday, 6);
  return {
    weekStartDate: format(monday, "yyyy-MM-dd"),
    weekEndDate: format(sunday, "yyyy-MM-dd"),
  };
}

