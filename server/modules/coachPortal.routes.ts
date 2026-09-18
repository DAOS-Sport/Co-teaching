import type { Express } from "express";
import { storage } from "../storage";
import { consumeLineLoginToken } from "./auth.routes";
import { actorContext } from "../shared/auth/auditContext";
import { MutationError } from "../shared/audit";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { notifyCoachNotFound, coachNotFoundMessage } from "./notification/coachNotFound";
import { fetchWithTimeout } from "../shared/http/fetchWithTimeout";
import {
  issueCoachSessionToken,
  readCoachSessionToken,
  resolveCoachToken,
  verifyCoachSessionFor,
} from "../shared/auth/coachPortalSession";
import { verifyAdminPassword, requireAdminPassword } from "../shared/auth/adminPassword";

declare global { namespace Express { interface Request { verifiedCoachId?: string } } }
export function registerCoachPortalRoutes(app: Express): void {
  app.use("/api/coach-portal", async (req, res, next) => {
    if (req.method !== "GET" || !["/availability", "/my-schedule", "/assigned-slots", "/colleagues", "/fill-status", "/venue-preferences"].includes(req.path)) return next();
    try {
      if (verifyAdminPassword(req)) { req.verifiedCoachId = typeof req.query.coachUserId === "string" ? req.query.coachUserId : undefined; return next(); }
      const session = await resolveCoachToken(req);
      const coach = session && await storage.getCoachUserById(session.coachUserId);
      if (!coach || coach.status !== "approved") return res.status(401).json({ message: "請登入" });
      if (req.query.coachName !== coach.name && req.query.coachName !== coach.linkedCoachName) return res.status(403).json({ message: "沒有此教練資料權限" });
      req.verifiedCoachId = coach.id;
      next();
    } catch (error) { next(error); }
  });
  // Linkable coaches (already approved but no LINE binding yet)
  app.get("/api/coach-portal/linkable-coaches", requireAdminPassword, async (_req, res) => {
    try {
      const approved = await storage.getApprovedCoachUsers();
      const linkable = approved
        .filter((c) => !c.lineId)
        .map((c) => ({ id: c.id, name: c.name }));
      res.json(linkable);
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      const matches = allCoaches.filter(
        (c) => c.name === trimmedName && c.status === "approved"
      );
      if (matches.length > 1) throw new MutationError("COACH_IDENTITY_AMBIGUOUS");
      const matched = matches[0];

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

      const notification = await notifyCoachNotFound(trimmedName, {
        token: env.lineChannelAccessToken, recipient: env.adminAlertLineUserId,
      });
      // Structured status only: no token, recipient, upstream body or personal data.
      console.info(JSON.stringify({ event: "coach_not_found_notification", at: new Date().toISOString(), ...notification }));
      return res.status(404).json({ message: coachNotFoundMessage(notification), notification });
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
        endDate,
        req.verifiedCoachId
      );
      res.json(mySchedules);
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      if (req.verifiedCoachId) {
        const own = await storage.getCoachSchedules(coachName, date, date, req.verifiedCoachId);
        if (venueIds.some(id => !own.some(s => s.venueId === id))) return res.status(403).json({ message: "沒有此場館資料權限" });
      }
      const colleagues = await storage.getColleaguesForCoach(
        coachName,
        date,
        venueIds
      );
      res.json(colleagues);
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
      console.error("Error fetching colleagues:", error);
      res.status(500).json({ message: "查詢同場教練失敗" });
    }
  });

  app.get("/api/coach-portal/approved-coaches", async (req, res) => {
    if (!verifyAdminPassword(req)) {
      const session = await resolveCoachToken(req);
      const coach = session && await storage.getCoachUserById(session.coachUserId);
      if (!coach || coach.status !== "approved") return res.status(401).json({ message: "請登入" });
      return res.json([{ id: coach.id, name: coach.name }]);
    }
    try {
      const users = await storage.getApprovedCoachUsers();
      res.json(users.map(c => ({ id: c.id, name: c.name })));
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
        weekStart,
        req.verifiedCoachId
      );
      res.json(availability);
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      let stableCoachId: string | undefined = req.body.coachUserId;
      // 確認寫入者只能修改自己的資料（管理員可繞過）
      if (!verifyAdminPassword(req)) {
        const session = await resolveCoachToken(req);
        if (!session) {
          return res.status(401).json({ message: "請先登入", code: "session_expired" });
        }
        const authUser = await storage.getCoachUserById(session.coachUserId);
        stableCoachId = authUser?.id;
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
      const write = () => storage.upsertCoachAvailability(coachName, weekStart, availableSlots, stableCoachId);
      if (verifyAdminPassword(req)) await write();
      else await actorContext.run({ id: stableCoachId!, role: "coach", requestId: randomUUID(), venueIds: [] }, write);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
      const prefs = await storage.getCoachVenuePreferences(coachName, req.verifiedCoachId);
      res.json(prefs.map((p) => p.venueName));
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
        await storage.getCoachFillStatus(coachName, req.verifiedCoachId);
      res.json({
        hasAvailability: availabilitySlots > 0,
        hasVenuePrefs: venuePrefsCount > 0,
      });
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
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
        endDate,
        req.verifiedCoachId
      );
      const assignedSlots = scheduleList.map((s) => {
        const dateObj = new Date(s.date + "T00:00:00");
        let dayOfWeek = dateObj.getDay();
        dayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek;
        return { dayOfWeek, timeSlotOrder: s.timeSlot.order };
      });
      res.json(assignedSlots);
    } catch (error) {
      if (error instanceof MutationError) return res.status(error.status).json({code:error.code,message:error.code});
      console.error("Error fetching assigned slots:", error);
      res.status(500).json({ message: "Failed to fetch assigned slots" });
    }
  });
}
