import { notificationBatchLimit, notificationBatchMayContinue, type NotificationBatchControl } from "./notification-batch";

export interface DailyCoach {
  id: string;
  name: string | null;
  linkedCoachName?: string | null;
  lineId?: string | null;
}
export interface DailySchedule {
  coachName: string | null;
  coachName2?: string | null;
  coach1IsTeaching?: boolean | null;
  coach2IsTeaching?: boolean | null;
  className?: string | null;
  venue: { name: string };
  timeSlot: { order?: number | null; startTime: string; endTime: string };
}
export interface DailyNotificationEntry {
  kind: "notification";
  coachName: string;
  accountId: string;
  notificationId: string;
  to: string;
  text: string;
}
export interface BlockedDailyEntry { kind: "blocked"; coachName: string; reason: "ambiguous" | "no_line_id" }
export interface DailyNotificationPlan {
  version: 1;
  targetDate: string;
  /** Persist the complete serializable plan in the existing parent job before processing any entry. */
  entries: (DailyNotificationEntry | BlockedDailyEntry)[];
}
export interface DailyPlanInput {
  coaches: DailyCoach[];
  schedules: DailySchedule[];
  portalUrl: string;
  notificationIdentity(purpose: string, values: unknown[]): string;
  isRealCoachName(value: string | null | undefined): boolean;
}

export function parseDailyTargetDate(targetDate: string): Date {
  if (typeof targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || targetDate.startsWith("0000-")) throw new Error("invalid_daily_target_date");
  const parsed = new Date(`${targetDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== targetDate) throw new Error("invalid_daily_target_date");
  return parsed;
}

/** Pure preparation: source data is copied to stable strings and never consulted while enqueuing. */
export function buildDailyNotifications(targetDate: string, input: DailyPlanInput): DailyNotificationPlan {
  const date = parseDailyTargetDate(targetDate);
  const display = `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
  const dayName = ["日", "一", "二", "三", "四", "五", "六"][date.getUTCDay()];
  const accounts = new Map<string, DailyCoach[]>();
  for (const coach of input.coaches) {
    const name = coach.linkedCoachName || coach.name;
    if (name) accounts.set(name, [...(accounts.get(name) ?? []), coach]);
  }
  const scheduled = new Set<string>();
  for (const item of input.schedules) {
    if (input.isRealCoachName(item.coachName) && item.coachName) scheduled.add(item.coachName);
    if (input.isRealCoachName(item.coachName2) && item.coachName2) scheduled.add(item.coachName2);
  }
  const entries: DailyNotificationPlan["entries"] = [];
  for (const coachName of Array.from(scheduled).sort()) {
    const candidates = accounts.get(coachName) ?? [];
    // Even an account without LINE makes the name ambiguous: never arbitrarily pick its peer.
    if (candidates.length > 1) { entries.push({ kind: "blocked", coachName, reason: "ambiguous" }); continue; }
    const coach = candidates[0];
    if (!coach?.lineId) { entries.push({ kind: "blocked", coachName, reason: "no_line_id" }); continue; }
    const lessons = input.schedules.filter(item => item.coachName === coachName || item.coachName2 === coachName)
      .sort((a, b) => (a.timeSlot?.order ?? 0) - (b.timeSlot?.order ?? 0));
    let text = `📋 明日課程提醒\n${display}(${dayName})\n\n${coachName} 教練，您好！\n明天共有 ${lessons.length} 堂課：\n`;
    for (const lesson of lessons) {
      const primary = lesson.coachName === coachName;
      const role = primary ? (lesson.coach1IsTeaching ? "當班教學" : "教練") : (lesson.coach2IsTeaching ? "當班教學" : "協助");
      text += `\n🏊 ${lesson.venue.name}${lesson.className ? ` ${lesson.className}` : ""}\n⏰ ${lesson.timeSlot.startTime}-${lesson.timeSlot.endTime} [${role}]\n`;
    }
    text += `\n請務必準時抵達場館！\n\n📌 課表如有異動請以系統為主：\n${input.portalUrl}`;
    entries.push({ kind: "notification", coachName, accountId: coach.id, notificationId: input.notificationIdentity("daily-reminder", [targetDate, coach.id]), to: coach.lineId, text });
  }
  return { version: 1, targetDate, entries };
}

export interface DailyEnqueueDependencies {
  findSavedTextNotification(id: string, control?: NotificationBatchControl): Promise<unknown | null>;
  dailyLogAlreadyExists(coachName: string, targetDate: string, control?: NotificationBatchControl): Promise<boolean>;
  enqueueTextNotification(input: { notificationId: string; to: string; text: string; reuseSavedPayload: true; latestCreateAt?:number }, control?: NotificationBatchControl): Promise<{ state: string }>;
}
export interface DailyEnqueueOptions extends NotificationBatchControl { limit?: number; cursor?: number | null; dryRun?: boolean; latestCreateAt?: number }

/** Only durable enqueue; neither transport nor compatibility-log mutation is permitted in this unit. */
export async function enqueueDailyNotifications(plan: DailyNotificationPlan, dependencies: DailyEnqueueDependencies, options: DailyEnqueueOptions = {}) {
  parseDailyTargetDate(plan.targetDate);
  if (plan.version !== 1 || !Array.isArray(plan.entries)) throw new Error("invalid_daily_notification_plan");
  const limit = notificationBatchLimit(options.limit);
  if(options.latestCreateAt!==undefined&&!Number.isFinite(options.latestCreateAt))throw new Error('invalid_daily_create_deadline');
  let cursor = options.cursor ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > plan.entries.length) throw new Error("invalid_daily_notification_cursor");
  let queued = 0, visited = 0, unknown = 0, ambiguous = 0, noLineId = 0, previewed = 0;
  while (cursor < plan.entries.length && visited < limit && notificationBatchMayContinue(options)) {
    const entry = plan.entries[cursor];
    if (entry.kind === "blocked") {
      if (entry.reason === "ambiguous") ambiguous++;
      else if (entry.reason === "no_line_id") noLineId++;
      else throw new Error("invalid_daily_notification_block_reason");
    } else if (entry.kind !== "notification" || !entry.notificationId || !entry.accountId || !entry.to || !entry.text || !entry.coachName) {
      throw new Error("invalid_daily_notification_entry");
    } else if (options.dryRun) previewed++;
    else {
      const prior = await dependencies.findSavedTextNotification(entry.notificationId, options);
      if (!notificationBatchMayContinue(options)) break;
      let legacy = false;
      if(!prior&&options.latestCreateAt!==undefined&&(options.now??Date.now)()>=options.latestCreateAt) {
        unknown++;visited++;cursor++;continue;
      }
      if (!prior) {
        legacy = await dependencies.dailyLogAlreadyExists(entry.coachName, plan.targetDate, options);
        if (!notificationBatchMayContinue(options)) break;
      }
      if (legacy) unknown++;
      else if(!prior&&options.latestCreateAt!==undefined&&(options.now??Date.now)()>=options.latestCreateAt)unknown++;
      else {
        const result = await dependencies.enqueueTextNotification({ notificationId: entry.notificationId, to: entry.to, text: entry.text, reuseSavedPayload: true,...(!prior&&options.latestCreateAt!==undefined?{latestCreateAt:options.latestCreateAt}:{}) }, options);
        if (result.state === "not_configured") throw new Error("daily_notification_queue_not_configured");
        if (!["pending", "existing"].includes(result.state)) throw new Error("daily_notification_enqueue_unconfirmed");
        queued++;
      }
    }
    visited++;
    cursor++;
  }
  const complete = cursor === plan.entries.length;
  return { queued, visited, unknown, ambiguous, noLineId, previewed, nextCursor: complete ? null : cursor, complete };
}
