import { isRealCoachName } from '../scheduling/policies';
import type { BuiltWeeklyRecipient, WeeklyRun } from './entities';
import type { WeeklyPushDependencies } from './ports';

export async function buildWeeklyRecipients<Run extends WeeklyRun>(
  deps: WeeklyPushDependencies<Run>, start: string, end: string,
): Promise<BuiltWeeklyRecipient[]> {
  const approved = await deps.roster.approvedCoaches();
  const coaches = approved.filter(coach => coach.lineId && (coach.linkedCoachName || coach.name));
  if (coaches.length === 0) return [];
  const schedules = await deps.roster.schedules(start, end);
  // Index each schedule once per coach. Exact legacy matching and source order remain intact.
  const byName = new Map<string, typeof schedules>();
  for (const schedule of schedules) {
    for (const name of Array.from(new Set([schedule.coachName, schedule.coachName2]))) {
      if (!isRealCoachName(name)) continue;
      const mine = byName.get(name) ?? [];
      mine.push(schedule); byName.set(name, mine);
    }
  }
  const accountsByName = new Map<string, Set<string>>();
  for (const coach of coaches) {
    const name = (coach.linkedCoachName || coach.name)!;
    if (!isRealCoachName(name) || !byName.has(name)) continue;
    const accounts = accountsByName.get(name) ?? new Set<string>();
    accounts.add(coach.id);
    if (accounts.size > 1) throw Error('weekly_push_ambiguous_scheduled_coach');
    accountsByName.set(name, accounts);
  }
  const recipients: BuiltWeeklyRecipient[] = [];
  for (const coach of coaches) {
    const name = (coach.linkedCoachName || coach.name)!;
    if (!isRealCoachName(name)) continue;
    const mine = byName.get(name) ?? [];
    if (mine.length === 0) continue;
    const items = mine.map(schedule => ({ date: schedule.date, venueName: schedule.venue.name,
      timeSlotLabel: `${schedule.timeSlot.startTime}-${schedule.timeSlot.endTime}`,
      className: schedule.className, timeSlotOrder: schedule.timeSlot.order }));
    const message = deps.message(name, items, start, end);
    recipients.push({ recipientName: name, recipientId: coach.id, lineUserId: coach.lineId!,
      scheduleCount: mine.length, payload: { message, scheduleCount: mine.length } });
  }
  return recipients;
}
