import { format } from "date-fns";
import { zhTW } from "date-fns/locale";
import { env } from "../../config/env";
import type { WeeklyMessageItem as ScheduleItem } from "../../core/weekly-push/entities";
const DAY_NAMES = ["", "一", "二", "三", "四", "五", "六", "日"];

export function buildCoachWeeklyMessage(
  coachName: string,
  schedules: ScheduleItem[],
  weekStartDate: string,
  weekEndDate: string,
): string {
  const monday = new Date(`${weekStartDate}T00:00:00`);
  const sunday = new Date(`${weekEndDate}T00:00:00`);

  const byDay = new Map<string, ScheduleItem[]>();
  for (const s of schedules) {
    if (!byDay.has(s.date)) byDay.set(s.date, []);
    byDay.get(s.date)!.push(s);
  }
  const sortedDates = Array.from(byDay.keys()).sort();

  let msg = "📋 下週課程通知\n";
  msg += `${format(monday, "M/d", { locale: zhTW })}(一) ~ ${format(sunday, "M/d", { locale: zhTW })}(日)\n\n`;
  msg += `${coachName} 老師，您好!\n`;
  msg += `您下週共有 ${schedules.length} 堂課:\n`;

  for (const dateKey of sortedDates) {
    const d = new Date(`${dateKey}T00:00:00`);
    const dow = d.getDay();
    const dayName = DAY_NAMES[dow === 0 ? 7 : dow];
    msg += `\n📅 ${format(d, "M/d")}(${dayName})\n`;

    const items = byDay
      .get(dateKey)!
      .sort((a, b) => a.timeSlotOrder - b.timeSlotOrder);
    for (const item of items) {
      msg += `  🏊 ${item.venueName}\n`;
      msg += `  ⏰ ${item.timeSlotLabel}`;
      if (item.className) msg += ` - ${item.className}`;
      msg += "\n";
    }
  }

  msg += "\n---\n請教練務必於課前準時抵達場館,主動向授課老師致意,並請確實熟悉「教練守則」。\n\n";
  msg += "自本學期起,協同課程費用修正如下:\n• 單節課 250元\n• 兩節課合併 500元";
  msg += `\n\n📌 課表如有異動請以系統為主：\n${env.publicOrigin}/coach-portal`;
  return msg;
}

