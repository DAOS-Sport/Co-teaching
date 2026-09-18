import type { Express } from "express";
import { storage } from "../storage";
import { consumeLineLoginToken } from "./auth.routes";
import { env } from "../config/env";
import { fetchWithTimeout } from "../shared/http/fetchWithTimeout";
import {
  issueCoachSessionToken,
  readCoachSessionToken,
  resolveCoachToken,
  verifyCoachSessionFor,
} from "../shared/auth/coachPortalSession";
import { verifyAdminPassword } from "../shared/auth/adminPassword";

export function registerCoachPortalRoutes(app: Express): void {
  // Linkable coaches (already approved but no LINE binding yet)
  app.get("/api/coach-portal/linkable-coaches", async (_req, res) => {
    try {
      const approved = await storage.getApprovedCoachUsers();
      const linkable = approved
        .filter((c) => !c.lineId)
        .map((c) => ({ id: c.id, name: c.name }));
      res.json(linkable);
    } catch (error) {
      res.status(500).json({ message: "查詢失敗" });
    }
  });

  app.post("/api/coach-portal/link-existing", async (req, res) => {
    try {
      const { lineToken, coachUserId } = req.body;
      if (!lineToken || !coachUserId) {
        return res.status(400).json({ message: "缺少必要參數" });
      }
      const tokenData = consumeLineLoginToken(lineToken);
      if (!tokenData || tokenData.existingCoachUserId) {
        return res
          .status(400)
          .json({ message: "LINE 登入已過期，請重新登入" });
      }
      const existing = await storage.getCoachUserByLineId(tokenData.lineId);
      if (existing) {
        const coachToken = await issueCoachSessionToken(existing.id, tokenData.lineId);
        return res.json({ ...existing, coachToken });
      }
      const updated = await storage.updateCoachUserLineId(
        coachUserId,
        tokenData.lineId
      );
      if (!updated) {
        return res.status(404).json({ message: "找不到教練帳號" });
      }
      const coachToken = await issueCoachSessionToken(updated.id, tokenData.lineId);
      res.json({ ...updated, coachToken });
    } catch (error) {
      console.error("Error linking LINE to coach:", error);
      res.status(500).json({ message: "連結失敗" });
    }
  });

  app.post("/api/coach-portal/link-by-name", async (req, res) => {
    try {
      const { lineToken, name } = req.body;
      if (!lineToken || !name?.trim()) {
        return res.status(400).json({ message: "缺少必要參數" });
      }
      const tokenData = consumeLineLoginToken(lineToken);
      if (!tokenData || tokenData.existingCoachUserId) {
        return res
          .status(400)
          .json({ message: "LINE 登入已過期，請重新登入" });
      }
      const trimmedName = name.trim();

      const existingByLine = await storage.getCoachUserByLineId(
        tokenData.lineId
      );
      if (existingByLine) {
        const coachToken = await issueCoachSessionToken(
          existingByLine.id,
          tokenData.lineId
        );
        return res.json({ ...existingByLine, coachToken });
      }

      const allCoaches = await storage.getAllCoachUsers();
      const matched = allCoaches.find(
        (c) => c.name === trimmedName && c.status === "approved"
      );

      if (matched) {
        const updated = await storage.updateCoachUserLineId(
          matched.id,
          tokenData.lineId
        );
        if (!updated) {
          return res.status(404).json({ message: "找不到教練帳號" });
        }
        const coachToken = await issueCoachSessionToken(updated.id, tokenData.lineId);
        return res.json({ ...updated, coachToken });
      }

      // Not found in DB → notify the admin alert LINE user via push.
      // Recipient is configured via ADMIN_ALERT_LINE_USER_ID; when unset
      // we downgrade to a console.warn rather than push to a stale id.
      const channelAccessToken = env.lineChannelAccessToken;
      const adminAlertId = env.adminAlertLineUserId;
      if (!adminAlertId) {
        console.warn(
          `[coach-portal] Coach "${trimmedName}" not found and ADMIN_ALERT_LINE_USER_ID is not set — skipping LINE notification`,
        );
      }
      if (channelAccessToken && adminAlertId) {
        // Task #32: timeout-bounded; never let a stalled LINE call hold
        // the registration response open.
        const notifyResult = await fetchWithTimeout(
          "https://api.line.me/v2/bot/message/push",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${channelAccessToken}`,
            },
            body: JSON.stringify({
              to: adminAlertId,
              messages: [
                {
                  type: "text",
                  text: `【教練登入通知】\n教練「${trimmedName}」嘗試登入教練前台，但在 Ragic 資料庫中查無此名字。\n請確認該教練是否已建檔，或協助手動設定。`,
                },
              ],
            }),
          },
        );
        if (!notifyResult.ok) {
          console.error(
            `[LINE] Failed to notify admin alert user: status=${notifyResult.status} ` +
              `code=${notifyResult.errorCode} msg=${notifyResult.errorMessage ?? ""}`,
          );
        }
      }

      return res.status(404).json({
        message: `查無「${trimmedName}」的教練資料，已通知管理員，請稍候或聯繫陳柏榮。`,
      });
    } catch (error) {
      console.error("Error linking by name:", error);
      res.status(500).json({ message: "連結失敗" });
    }
  });

  app.post("/api/coach-portal/register", async (req, res) => {
    try {
      const { lineToken, name, phone, email } = req.body;

      if (!lineToken || typeof lineToken !== "string") {
        return res.status(400).json({ message: "請先使用 LINE 登入" });
      }

      const tokenData = consumeLineLoginToken(lineToken);
      if (!tokenData || tokenData.existingCoachUserId) {
        return res
          .status(400)
          .json({ message: "LINE 登入已過期，請重新登入" });
      }

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ message: "姓名為必填欄位" });
      }

      const existingUser = await storage.getCoachUserByLineId(tokenData.lineId);
      if (existingUser) {
        const coachToken = await issueCoachSessionToken(
          existingUser.id,
          tokenData.lineId
        );
        return res.json({ ...existingUser, coachToken });
      }

      const coachUser = await storage.createCoachUser({
        lineId: tokenData.lineId,
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        status: "pending",
        role: "coach",
        linkedCoachName: null,
      });

      const coachToken = await issueCoachSessionToken(coachUser.id, tokenData.lineId);
      res.json({ ...coachUser, coachToken });
    } catch (error) {
      console.error("Error registering coach user:", error);
      res.status(500).json({ message: "註冊失敗" });
    }
  });

  // PII-bearing endpoint: gated by either a coach-portal session token bound
  // to this identifier, or admin password. Returns 403 with a clear marker so
  // the frontend can distinguish "session expired" from "user not found".
  app.get("/api/coach-portal/me/:identifier", async (req, res) => {
    try {
      const { identifier } = req.params;

      const isAdmin = verifyAdminPassword(req);
      if (!isAdmin) {
        const token = readCoachSessionToken(req);
        const session = await verifyCoachSessionFor(token, identifier);
        if (!session) {
          return res
            .status(403)
            .json({ message: "請重新登入", code: "session_expired" });
        }
      }

      let user = await storage.getCoachUserByLineId(identifier);
      if (!user) {
        user = await storage.getCoachUserById(identifier);
      }
      if (!user) {
        return res.status(404).json({ message: "找不到用戶" });
      }
      res.json(user);
    } catch (error) {
      console.error("Error fetching coach user:", error);
      res.status(500).json({ message: "查詢失敗" });
    }
  });

  app.get("/api/coach-portal/my-schedule", async (req, res) => {
    try {
      const { coachName, startDate, endDate } = req.query as {
        coachName: string;
        startDate: string;
        endDate: string;
      };
      if (!coachName || !startDate || !endDate) {
        return res.status(400).json({ message: "缺少必要參數" });
      }
      const mySchedules = await storage.getCoachSchedules(
        coachName,
        startDate,
        endDate
      );
      res.json(mySchedules);
    } catch (error) {
      console.error("Error fetching personal schedule:", error);
      res.status(500).json({ message: "查詢個人課表失敗" });
    }
  });

  app.get("/api/coach-portal/colleagues", async (req, res) => {
    try {
      const { coachName, date, venueIds: venueIdsStr } = req.query as {
        coachName: string;
        date: string;
        venueIds: string;
      };
      if (!coachName || !date || !venueIdsStr) {
        return res.status(400).json({ message: "缺少必要參數" });
      }
      const venueIds = venueIdsStr.split(",").map((v) => v.trim()).filter(Boolean);
      const colleagues = await storage.getColleaguesForCoach(
        coachName,
        date,
        venueIds
      );
      res.json(colleagues);
    } catch (error) {
      console.error("Error fetching colleagues:", error);
      res.status(500).json({ message: "查詢同場教練失敗" });
    }
  });

  app.get("/api/coach-portal/approved-coaches", async (_req, res) => {
    try {
      const users = await storage.getApprovedCoachUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching approved coaches:", error);
      res.status(500).json({ message: "查詢已通過教練失敗" });
    }
  });

  // Availability
  app.get("/api/coach-portal/availability", async (req, res) => {
    try {
      const { coachName, weekStart } = req.query as {
        coachName: string;
        weekStart: string;
      };
      if (!coachName || !weekStart) {
        return res.status(400).json({ message: "Missing coachName or weekStart" });
      }
      const availability = await storage.getCoachAvailabilityForCoach(
        coachName,
        weekStart
      );
      res.json(availability);
    } catch (error) {
      console.error("Error fetching coach availability:", error);
      res.status(500).json({ message: "Failed to fetch coach availability" });
    }
  });

  app.post("/api/coach-portal/availability", async (req, res) => {
    try {
      const { coachName, weekStart, slots } = req.body as {
        coachName: string;
        weekStart: string;
        slots: { dayOfWeek: number; timeSlotOrder: number; available?: boolean }[];
      };
      if (!coachName || !weekStart || !Array.isArray(slots)) {
        return res
          .status(400)
          .json({ message: "Missing coachName, weekStart, or slots" });
      }
      // 確認寫入者只能修改自己的資料（管理員可繞過）
      if (!verifyAdminPassword(req)) {
        const session = await resolveCoachToken(req);
        if (!session) {
          return res.status(401).json({ message: "請先登入", code: "session_expired" });
        }
        const authUser = await storage.getCoachUserById(session.coachUserId);
        const authName = authUser?.linkedCoachName ?? authUser?.name;
        if (!authName || authName !== coachName) {
          return res.status(403).json({ message: "無權限修改此教練資料" });
        }
      }
      const availableSlots = slots.filter((s) => s.available !== false);
      for (const slot of availableSlots) {
        if (
          slot.dayOfWeek < 1 ||
          slot.dayOfWeek > 7 ||
          slot.timeSlotOrder < 1 ||
          slot.timeSlotOrder > 7
        ) {
          return res
            .status(400)
            .json({ message: "dayOfWeek must be 1-7, timeSlotOrder must be 1-7" });
        }
      }
      await storage.upsertCoachAvailability(
        coachName,
        weekStart,
        availableSlots
      );
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving coach availability:", error);
      res.status(500).json({ message: "Failed to save coach availability" });
    }
  });

  app.get("/api/coach-portal/venue-preferences", async (req, res) => {
    try {
      const { coachName } = req.query as { coachName: string };
      if (!coachName) {
        return res.status(400).json({ message: "Missing coachName" });
      }
      const prefs = await storage.getCoachVenuePreferences(coachName);
      res.json(prefs.map((p) => p.venueName));
    } catch (error) {
      console.error("Error fetching coach venue preferences:", error);
      res.status(500).json({ message: "Failed to fetch venue preferences" });
    }
  });

  app.post("/api/coach-portal/venue-preferences", async (req, res) => {
    return res.status(410).json({ code: "VENUE_PREFERENCES_DISABLED", message: "可排課地點由管理端統一設定" });
  });

  app.get("/api/coach-portal/fill-status", async (req, res) => {
    try {
      const { coachName } = req.query as { coachName: string };
      if (!coachName)
        return res.status(400).json({ message: "Missing coachName" });
      const { availabilitySlots, venuePrefsCount } =
        await storage.getCoachFillStatus(coachName);
      res.json({
        hasAvailability: availabilitySlots > 0,
        hasVenuePrefs: venuePrefsCount > 0,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch fill status" });
    }
  });

  app.get("/api/coach-portal/assigned-slots", async (req, res) => {
    try {
      const { coachName, startDate, endDate } = req.query as {
        coachName: string;
        startDate: string;
        endDate: string;
      };
      if (!coachName || !startDate || !endDate) {
        return res.status(400).json({ message: "Missing parameters" });
      }
      const scheduleList = await storage.getCoachSchedules(
        coachName,
        startDate,
        endDate
      );
      const assignedSlots = scheduleList.map((s) => {
        const dateObj = new Date(s.date + "T00:00:00");
        let dayOfWeek = dateObj.getDay();
        dayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek;
        return { dayOfWeek, timeSlotOrder: s.timeSlot.order };
      });
      res.json(assignedSlots);
    } catch (error) {
      console.error("Error fetching assigned slots:", error);
      res.status(500).json({ message: "Failed to fetch assigned slots" });
    }
  });
}
