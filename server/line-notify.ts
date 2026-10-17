import { featureFlags } from "./config/featureFlags";
import { currentDb } from "./shared/dbContext";
import { enqueueTextNotification , findSavedTextNotification } from "./modules/notification/delivery.service";
import { notificationIdentity, sendDurableText } from "./modules/notification/delivery.service";
import { isRealCoachName } from "@shared/scheduleRules";
import { storage } from './storage';
import { format, addDays, startOfWeek, parseISO } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { db } from './db';
import { lineNotifyLogs, coachUsers, coachAvailability, coachVenuePreferences, schedules, venues, timeSlots } from '@shared/schema';
import { eq, and, between } from 'drizzle-orm';
import { env } from './config/env';

// 教練前台連結 — 推播訊息結尾附上，提醒教練以系統公告為準
const coachPortalUrl = (): string => `${env.publicOrigin}/coach-portal`;



const DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];

interface ScheduleItem {
  date: string;
  venueName: string;
  timeSlotLabel: string;
  className: string | null;
  timeSlotOrder: number;
}

/**
 * App-level fast-path dedup check for daily notifications.
 *
 * The DB unique index `uniq_daily_notify` on
 * (coach_name, notify_type, schedule_date) is the ultimate source of
 * truth — this helper is a cheap optimization that lets us skip
 * message assembly and the INSERT round-trip when we can already see
 * a row exists.
 */
async function dailyLogAlreadyExists(
  coachName: string,
  scheduleDate: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: lineNotifyLogs.id })
    .from(lineNotifyLogs)
    .where(
      and(
        eq(lineNotifyLogs.coachName, coachName),
        eq(lineNotifyLogs.notifyType, 'daily'),
        eq(lineNotifyLogs.scheduleDate, scheduleDate),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

export async function sendLinePushMessage(lineId: string, message: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await sendDurableText({ notificationId: notificationIdentity("legacy-message-day", [day, lineId, message]), to: lineId, text: message });
  return result.accepted;
}

/**
 * App-level fast-path dedup check for weekly notifications.
 * Checks if a 'weekly' record for this coach already exists for the given week start date.
 * The weekly cron insert logs one row per scheduled day — checking the first day is sufficient.
 */
async function weeklyLogAlreadyExists(
  coachName: string,
  weekStartDate: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: lineNotifyLogs.id })
    .from(lineNotifyLogs)
    .where(
      and(
        eq(lineNotifyLogs.coachName, coachName),
        eq(lineNotifyLogs.notifyType, 'weekly'),
        eq(lineNotifyLogs.scheduleDate, weekStartDate),
      ),
    )
    .limit(1);
  return existing.length > 0;
}

async function sendWeeklyScheduleNotifications(): Promise<void> {
  console.log('[LINE Notify] Starting weekly schedule notifications...');

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE Notify] LINE_CHANNEL_ACCESS_TOKEN not configured, skipping notifications');
    return;
  }

  try {
    const approvedCoaches = await storage.getApprovedCoachUsers();
    // 優先用 linkedCoachName，沒有則用 name 作為比對鍵
    const coachesWithLine = approvedCoaches.filter(c => c.lineId && (c.linkedCoachName || c.name));

    if (coachesWithLine.length === 0) {
      console.log('[LINE Notify] No approved coaches with LINE accounts found');
      return;
    }

    const today = new Date();
    // addDays(today, 1) 確保：週日 cron 看下週，週一~週六手動觸發看本週
    const nextMonday = startOfWeek(addDays(today, 1), { weekStartsOn: 1 });
    const nextSunday = addDays(nextMonday, 6);
    const startDate = format(nextMonday, 'yyyy-MM-dd');
    const endDate = format(nextSunday, 'yyyy-MM-dd');

    const weekSchedules = await storage.getSchedulesByDateRange(startDate, endDate);

    let sentCount = 0;
    let failCount = 0;

    for (const coach of coachesWithLine) {
      try {
      const coachName = (coach.linkedCoachName || coach.name)!;
      if (!isRealCoachName(coachName)) continue;
      const lineId = coach.lineId!;

      // 去重：同一週若已推播過，跳過（防止 cron + 手動觸發重複送出）
      if (await weeklyLogAlreadyExists(coachName, startDate)) {
        console.log(`[LINE Notify] Weekly: skip ${coachName} (already sent for week ${startDate})`);
        continue;
      }

      const mySchedules = weekSchedules.filter(
        s => s.coachName === coachName || s.coachName2 === coachName
      );

      if (mySchedules.length === 0) continue;

      const schedulesByDay = new Map<string, ScheduleItem[]>();
      for (const s of mySchedules) {
        const dateKey = s.date;
        if (!schedulesByDay.has(dateKey)) {
          schedulesByDay.set(dateKey, []);
        }
        schedulesByDay.get(dateKey)!.push({
          date: s.date,
          venueName: s.venue.name,
          timeSlotLabel: `${s.timeSlot.startTime}-${s.timeSlot.endTime}`,
          className: s.className,
          timeSlotOrder: s.timeSlot.order,
        });
      }

      const sortedDates = Array.from(schedulesByDay.keys()).sort();

      let message = `📋 下週課程通知\n`;
      message += `${format(nextMonday, 'M/d', { locale: zhTW })}(一) ~ ${format(nextSunday, 'M/d', { locale: zhTW })}(日)\n\n`;
      message += `${coachName} 老師，您好！\n`;
      message += `您下週共有 ${mySchedules.length} 堂課：\n`;

      for (const dateKey of sortedDates) {
        const d = new Date(dateKey + 'T00:00:00');
        const dayOfWeek = d.getDay();
        const dayName = DAY_NAMES[dayOfWeek === 0 ? 7 : dayOfWeek];
        message += `\n📅 ${format(d, 'M/d')}(${dayName})\n`;

        const items = schedulesByDay.get(dateKey)!.sort((a, b) => a.timeSlotOrder - b.timeSlotOrder);
        for (const item of items) {
          message += `  🏊 ${item.venueName}\n`;
          message += `  ⏰ ${item.timeSlotLabel}`;
          if (item.className) {
            message += ` - ${item.className}`;
          }
          message += `\n`;
        }
      }

      message += `\n---\n請教練務必於課前準時抵達場館，主動向授課老師致意，並請確實熟悉「教練守則」。\n\n自本學期起，協同課程費用修正如下：\n• 單節課 250元\n• 兩節課合併 500元`;
      message += `\n\n📌 課表如有異動請以系統為主：\n${coachPortalUrl()}`;

      const success = await sendLinePushMessage(lineId, message);
      if (success) {
        sentCount++;
        console.log(`[LINE Notify] Sent to ${coachName}`);
        // Log one record per scheduled date so date-based queries find the push
        for (const dateKey of sortedDates) {
          await db.insert(lineNotifyLogs).values({
            coachName,
            lineId,
            content: message,
            notifyType: 'weekly',
            scheduleDate: dateKey,
          }).catch(e => console.error('[LINE Notify] Failed to log weekly push:', e));
        }
      } else {
        failCount++;
      }
      } catch (coachErr) {
        console.error(`[LINE Notify] Weekly: unexpected error for coach, skipping:`, coachErr);
        failCount++;
      }
    }

    console.log(`[LINE Notify] Done. Sent: ${sentCount}, Failed: ${failCount}`);
  } catch (error) {
    console.error('[LINE Notify] Error sending weekly notifications:', error);
  }
}

export async function setupWeeklyNotificationCron() {
  const { configureNotificationSchedules } = await import("./infra/queue/runtime");
  return configureNotificationSchedules({ enabled: true, kinds: ["weekly"] });
}

async function sendDailyTomorrowNotifications(): Promise<void> {
  console.log('[LINE Notify] Starting daily tomorrow notifications...');

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log('[LINE Notify] LINE_CHANNEL_ACCESS_TOKEN not configured, skipping');
    return;
  }

  try {
    // ── 1. 計算台灣明天日期（UTC+8 明確處理，避免時區錯誤）
    const nowUtc = Date.now();
    const taiwanNow = new Date(nowUtc + 8 * 60 * 60 * 1000); // 轉成 UTC+8
    const taiwanTomorrow = new Date(taiwanNow.getTime() + 24 * 60 * 60 * 1000);
    const yy = taiwanTomorrow.getUTCFullYear();
    const mm = String(taiwanTomorrow.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(taiwanTomorrow.getUTCDate()).padStart(2, '0');
    const tomorrowStr = `${yy}-${mm}-${dd}`;
    const tomorrowDisplay = `${taiwanTomorrow.getUTCMonth() + 1}/${taiwanTomorrow.getUTCDate()}`;
    const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const tomorrowDayName = dayNames[taiwanTomorrow.getUTCDay()];

    console.log(`[LINE Notify] Daily: targeting date ${tomorrowStr}`);

    // ── 2. 取得明天所有課程（含場館、時段 join）
    const tomorrowSchedules = await storage.getSchedulesByDateRange(tomorrowStr, tomorrowStr);
    if (tomorrowSchedules.length === 0) {
      console.log(`[LINE Notify] No schedules for tomorrow (${tomorrowStr}), skipping`);
      return;
    }

    // ── 3. 建立 coachName → coachUser 對照表（用 linkedCoachName 優先）
    const approvedCoaches = await storage.getApprovedCoachUsers();
    const coachMap = new Map<string, typeof approvedCoaches[0]>();
    const ambiguousCoaches = new Set<string>();
    for (const c of approvedCoaches) {
      if (!c.lineId) continue;
      const key = c.linkedCoachName || c.name;
      if (!key) continue;
      if (coachMap.has(key) || ambiguousCoaches.has(key)) { coachMap.delete(key); ambiguousCoaches.add(key); }
      else coachMap.set(key, c);
    }

    // ── 5. 收集明天有課的教練名單（去重）
    const scheduledCoachNames = new Set<string>();
    for (const s of tomorrowSchedules) {
      if (isRealCoachName(s.coachName)) scheduledCoachNames.add(s.coachName);
      if (isRealCoachName(s.coachName2)) scheduledCoachNames.add(s.coachName2);
    }

    const noLineIdCoaches: string[] = [];
    let sentCount = 0;
    let skipDupCount = 0;
    let failCount = 0;

    // ── 6. 對每位有課的教練，組訊息並推播
    for (const coachName of Array.from(scheduledCoachNames)) {
      try {
      // 6a. 有無 LINE ID
      if (ambiguousCoaches.has(coachName)) { failCount++; console.error("daily_notification_ambiguous_recipient"); continue; }
        const coach = coachMap.get(coachName);
      if (!coach) {
        noLineIdCoaches.push(coachName);
        continue;
      }

      // 6b. 找出這位教練的所有明天課程，依節次排序
      const mySchedules = tomorrowSchedules
        .filter(s => s.coachName === coachName || s.coachName2 === coachName)
        .sort((a, b) => (a.timeSlot?.order ?? 0) - (b.timeSlot?.order ?? 0));
      if (mySchedules.length === 0) continue;

      // 6b'. 應用層快路徑：若已有當日記錄，直接跳過，省下訊息組裝與 INSERT
      //      （DB unique index 仍是最終事實來源，下面的 ON CONFLICT 才是真正的鎖）
      

      // 6c. 組訊息
      let message = `📋 明日課程提醒\n`;
      message += `${tomorrowDisplay}(${tomorrowDayName})\n\n`;
      message += `${coachName} 教練，您好！\n`;
      message += `明天共有 ${mySchedules.length} 堂課：\n`;
      for (const s of mySchedules) {
        const isCoach1 = s.coachName === coachName;
        const role = isCoach1
          ? (s.coach1IsTeaching ? '當班教學' : '教練')
          : (s.coach2IsTeaching ? '當班教學' : '協助');
        message += `\n🏊 ${s.venue.name}`;
        if (s.className) message += ` ${s.className}`;
        message += `\n⏰ ${s.timeSlot.startTime}-${s.timeSlot.endTime}`;
        message += ` [${role}]\n`;
      }
      message += `\n請務必準時抵達場館！`;
      message += `\n\n📌 課表如有異動請以系統為主：\n${coachPortalUrl()}`;

      // 6d. 原子防重：先 INSERT log（ON CONFLICT DO NOTHING）搶到「鎖」才推
      //     若 returning 為空 → 同一秒被別的執行緒搶走，跳過
      const notificationId = notificationIdentity("daily-reminder", [tomorrowStr, coach.id]);
        const prior = await findSavedTextNotification(notificationId);
        if (!prior && await dailyLogAlreadyExists(coachName, tomorrowStr)) {
          failCount++;
          console.error("daily_notification_unknown_legacy_untracked_operator_review_required");
          continue;
        }
        const delivery = await sendDurableText({ notificationId, to: coach.lineId!, text: message, reuseSavedPayload: true });
        if (delivery.accepted) {
          sentCount++;
          await db.insert(lineNotifyLogs).values({ coachName, lineId: coach.lineId!, content: message, notifyType: "daily", scheduleDate: tomorrowStr })
            .onConflictDoNothing({ target: [lineNotifyLogs.coachName, lineNotifyLogs.notifyType, lineNotifyLogs.scheduleDate] });
        } else { failCount++; console.error("daily_notification_" + delivery.state); }
      } catch (coachErr) {
        console.error(`[LINE Notify] Daily: unexpected error for ${coachName}, skipping:`, coachErr);
        failCount++;
      }
    }

    if (noLineIdCoaches.length > 0) {
      console.log(`[LINE Notify] No LINE ID: ${noLineIdCoaches.join(', ')}`);
    }
    console.log(`[LINE Notify] Daily done. Date=${tomorrowStr} Sent=${sentCount} SkipDup=${skipDupCount} Failed=${failCount} NoLineId=${noLineIdCoaches.length}`);
  
    if (failCount > 0) throw new Error("daily_notifications_incomplete_or_unknown");
  } catch (error) {
    console.error('[LINE Notify] Error sending daily notifications:', error);
  
    throw error;
  }
}

// SWIM-02: 課表解鎖通知
export async function notifyScheduleUnlocked(venueId: string, startDate: string, endDate: string) {
  const rows = await currentDb().select({ id: schedules.id, version: schedules.version }).from(schedules).where(and(eq(schedules.venueId, venueId), between(schedules.date, startDate, endDate)));
  return enqueueScheduleUnlocked(venueId, startDate, endDate, notificationIdentity("legacy-unlock-snapshot", rows.sort((a,b) => a.id.localeCompare(b.id))));
}

// SWIM-03: 發送填寫提醒給尚未填寫的教練
export async function sendFillReminderToCoaches(): Promise<{ sent: number }> {
  const approved = await storage.getApprovedCoachUsers();
  const withLine = approved.filter(c => c.lineId);
  let sent = 0;
  for (const coach of withLine) {
    const coachName = coach.linkedCoachName || coach.name;
    if (!isRealCoachName(coachName)) continue;
    const avail = await db.select().from(coachAvailability).where(eq(coachAvailability.coachName, coachName)).limit(1);
    const prefs = await db.select().from(coachVenuePreferences).where(eq(coachVenuePreferences.coachName, coachName)).limit(1);
    const hasAvail = avail.length > 0;
    const hasPrefs = prefs.length > 0;
    if (hasAvail && hasPrefs) continue;
    const missing: string[] = [];
    if (!hasAvail) missing.push('可用時段（7×7 矩陣）');
    if (!hasPrefs) missing.push('可排課場館');
    const msg =
      `📝 填寫提醒\n` +
      `您尚未填寫以下資訊，請盡快完成：\n` +
      missing.map((m, i) => `${i + 1}. ${m}`).join('\n') +
      `\n\n請前往教練端填寫，謝謝！`;
    const ok = await sendLinePushMessage(coach.lineId!, msg).catch(() => false);
    if (ok) sent++;
  }
  return { sent };
}

export async function setupDailyNotificationCron() {
  const { configureNotificationSchedules } = await import("./infra/queue/runtime");
  return configureNotificationSchedules({ enabled: true, kinds: ["daily"] });
}

export { sendWeeklyScheduleNotifications, sendDailyTomorrowNotifications };

export async function enqueueScheduleUnlocked(venueId: string, startDate: string, endDate: string, operationId: string) {
  if (!featureFlags.enableWeeklyPushQueue) return { status: "not_configured" as const, notificationIds: [] as string[] };
  if (!operationId) throw new Error("A stable unlock operationId is required");
  const tx = currentDb();
  const rows = await tx.select({ coachName: schedules.coachName, coachName2: schedules.coachName2, venueName: venues.name }).from(schedules).innerJoin(venues, eq(schedules.venueId, venues.id)).where(and(eq(schedules.venueId, venueId), between(schedules.date, startDate, endDate)));
  const venueName = rows[0]?.venueName ?? "";
  const weekStr = format(parseISO(startDate), "M/d", { locale: zhTW });
  const notified = new Set<string>();
  const notificationIds: string[] = [];
  for (const row of rows) for (const name of [row.coachName, row.coachName2].filter(isRealCoachName)) {
    if (!name || notified.has(name)) continue;
    notified.add(name);
    const byLinked = await tx.select().from(coachUsers).where(eq(coachUsers.linkedCoachName, name)).limit(1);
    const byName = byLinked.length ? [] : await tx.select().from(coachUsers).where(eq(coachUsers.name, name)).limit(1);
    const coach = byLinked[0] ?? byName[0];
    if (!coach?.lineId) continue;
    const msg = `⚠️ 課表異動通知\n` +
          `${venueName} ${weekStr} 週的課表已更新，請重新確認您的排課內容。\n\n` +
          `建議重新查看教練端課表，並視需要重新匯出 Google Calendar。`;
    const result = await enqueueTextNotification({ notificationId: notificationIdentity("schedule-unlock", [operationId, venueId, startDate, endDate, coach.id]), to: coach.lineId, text: msg });
    notificationIds.push(result.notificationId);
  }
  return { status: "pending" as const, notificationIds };
}
