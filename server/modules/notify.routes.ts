import type { Express } from "express";
import { format } from "date-fns";
import { storage } from "../storage";
import {
  sendDailyTomorrowNotifications,
  sendFillReminderToCoaches,
} from "../line-notify";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { env } from "../config/env";
import { fetchWithTimeout } from "../shared/http/fetchWithTimeout";

export function registerNotifyRoutes(app: Express): void {
  app.get(
    "/api/admin/notify-logs",
    requireAdminPassword,
    async (req, res) => {
      const date = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      try {
        const daySchedules = await storage.getSchedulesByDateRange(date, date);
        const logs = await storage.getNotifyLogsByDate(date);

        const logMap = new Map<string, (typeof logs)[number]>();
        for (const log of logs) {
          const existing = logMap.get(log.coachName);
          if (!existing || log.sentAt > existing.sentAt) {
            logMap.set(log.coachName, log);
          }
        }

        const rows = daySchedules
          .filter((s) => s.className)
          .map((s) => {
            const coach1Log = s.coachName ? logMap.get(s.coachName) : null;
            const coach2Log = s.coachName2 ? logMap.get(s.coachName2) : null;
            return {
              scheduleId: s.id,
              date: s.date,
              venue: s.venue.name,
              period: s.timeSlot.period,
              startTime: s.timeSlot.startTime,
              endTime: s.timeSlot.endTime,
              className: s.className,
              coachName: s.coachName,
              coachName2: s.coachName2,
              coach1Log: coach1Log
                ? {
                    sentAt: coach1Log.sentAt,
                    content: coach1Log.content,
                    notifyType: coach1Log.notifyType,
                  }
                : null,
              coach2Log: coach2Log
                ? {
                    sentAt: coach2Log.sentAt,
                    content: coach2Log.content,
                    notifyType: coach2Log.notifyType,
                  }
                : null,
            };
          });

        res.json(rows);
      } catch (error) {
        console.error("notify-logs error:", error);
        res.status(500).json({ message: "查詢失敗" });
      }
    }
  );

  app.post(
    "/api/admin/send-notify-individual",
    requireAdminPassword,
    async (req, res) => {
      const { coachNames, date } = req.body as {
        coachNames: string[];
        date: string;
      };
      if (!Array.isArray(coachNames) || coachNames.length === 0 || !date) {
        return res.status(400).json({ message: "請提供教練名單與日期" });
      }

      const token = env.lineChannelAccessToken;
      if (!token) {
        return res.status(500).json({ message: "LINE 推播尚未設定" });
      }

      try {
        const daySchedules = await storage.getSchedulesByDateRange(date, date);
        const approvedCoaches = await storage.getApprovedCoachUsers();

        const coachMap = new Map<string, (typeof approvedCoaches)[number]>();
        approvedCoaches.forEach((c) => {
          const matchName = c.linkedCoachName || c.name;
          if (matchName && c.lineId) coachMap.set(matchName, c);
        });

        const dateObj = new Date(date + "T00:00:00");
        const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
        const dateDisplay = `${format(dateObj, "M/d")}(${dayNames[dateObj.getDay()]})`;

        let sentCount = 0;
        let failCount = 0;
        const results: { coachName: string; success: boolean }[] = [];

        for (const coachName of coachNames) {
          const coach = coachMap.get(coachName);
          if (!coach?.lineId) {
            results.push({ coachName, success: false });
            failCount++;
            continue;
          }

          const mySchedules = daySchedules
            .filter(
              (s) => s.coachName === coachName || s.coachName2 === coachName
            )
            .sort(
              (a, b) => (a.timeSlot?.order ?? 0) - (b.timeSlot?.order ?? 0)
            );

          if (mySchedules.length === 0) {
            results.push({ coachName, success: false });
            failCount++;
            continue;
          }

          let message = `📋 課程通知（手動補發）\n`;
          message += `${dateDisplay}\n\n`;
          message += `${coachName} 教練，您好！\n`;
          message += `以下是您當日共 ${mySchedules.length} 堂課：\n`;

          for (const s of mySchedules) {
            message += `\n🏊 ${s.venue.name}\n`;
            message += `⏰ ${s.timeSlot.startTime}-${s.timeSlot.endTime}`;
            if (s.className) message += ` - ${s.className}`;
            message += `\n`;
          }
          message += `\n請教練務必準時抵達場館！`;

          // Task #32: timeout-bounded; manual re-push is iterating a
          // potentially large coach list — one stalled call must not
          // block the entire batch.
          const pushRes = await fetchWithTimeout(
            "https://api.line.me/v2/bot/message/push",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                to: coach.lineId,
                messages: [{ type: "text", text: message }],
              }),
            }
          );

          if (pushRes.ok) {
            sentCount++;
            results.push({ coachName, success: true });
            await storage
              .insertNotifyLog({
                coachName,
                lineId: coach.lineId,
                content: message,
                notifyType: "manual",
                scheduleDate: date,
              })
              .catch((e) =>
                console.error("[LINE Notify] Failed to log manual push:", e)
              );
          } else {
            failCount++;
            results.push({ coachName, success: false });
          }
        }

        res.json({ success: true, sentCount, failCount, results });
      } catch (error) {
        console.error("Individual notify error:", error);
        res.status(500).json({ message: "推播發送失敗" });
      }
    }
  );

  app.post(
    "/api/admin/send-fill-reminder",
    requireAdminPassword,
    async (_req, res) => {
      try {
        const result = await sendFillReminderToCoaches();
        res.json({ success: true, sent: result.sent });
      } catch (error) {
        res.status(500).json({ message: "推播發送失敗" });
      }
    }
  );

  app.post(
    "/api/admin/notify-daily",
    requireAdminPassword,
    async (_req, res) => {
      try {
        await sendDailyTomorrowNotifications();
        res.json({ success: true, message: "每日推播已觸發" });
      } catch (error) {
        console.error("Manual daily notify error:", error);
        res.status(500).json({ message: "推播失敗", error: String(error) });
      }
    }
  );
}
