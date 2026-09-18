import type { Express } from "express";
import { format, addDays } from "date-fns";
import { storage } from "../storage";
import { insertScheduleSchema } from "@shared/schema";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { notifyScheduleUnlocked } from "../line-notify";
import {
  commitScheduleImport,
  previewScheduleImport,
} from "./scheduleImport.service";
import type { ScheduleImportMode } from "@shared/scheduleImport";
import { promoteCoachSlots, sameCoach } from "@shared/scheduleRules";

type ScheduleUpdate = Parameters<typeof storage.updateSchedule>[1];
const isDuplicateCoach = sameCoach;
const isPgUniqueViolation = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "23505";

export function registerScheduleRoutes(app: Express): void {
  // ── Static `/api/schedules/...` routes FIRST so Express does not match
  //    them against the `/:date` parameter route below.

  app.get("/api/schedules", async (req, res) => {
    try {
      const { startDate, endDate } = req.query as {
        startDate: string;
        endDate: string;
      };
      const schedules = await storage.getSchedulesByDateRange(startDate, endDate);
      res.json(schedules);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch schedules" });
    }
  });

  app.post("/api/schedules", requireAdminPassword, async (req, res) => {
    try {
      const validatedData = insertScheduleSchema.parse(req.body);
      if (isDuplicateCoach(validatedData.coachName, validatedData.coachName2)) {
        return res.status(400).json({ code: "DUPLICATE_COACH", message: "同一堂課不可指派同一位教練兩次" });
      }
      const schedule = await storage.upsertSchedule(validatedData);
      res.json(schedule);
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        return res.status(409).json({
          code: "DUPLICATE_CLASS_IN_CELL",
          message: "此時段已經有相同班級，沒有重複新增",
        });
      }
      res
        .status(400)
        .json({ message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  app.get("/api/schedules/lock-status", async (req, res) => {
    try {
      const { venueId, startDate, endDate } = req.query as {
        venueId: string;
        startDate: string;
        endDate: string;
      };
      if (!venueId || !startDate || !endDate) {
        return res.status(400).json({ message: "Missing parameters" });
      }
      const locked = await storage.getScheduleLockStatus(
        venueId,
        startDate,
        endDate
      );
      res.json({ isLocked: locked });
    } catch (error) {
      res.status(500).json({ message: "Failed to check lock status" });
    }
  });

  const readImportRequest = (body: unknown): {
    ok: true;
    venueId: string;
    text: string;
    mode: ScheduleImportMode;
  } | { ok: false; message: string } => {
    if (!body || typeof body !== "object") return { ok: false, message: "請提供匯入資料" };
    const input = body as Record<string, unknown>;
    const venueId = typeof input.venueId === "string" ? input.venueId.trim() : "";
    const text = typeof input.text === "string" ? input.text : "";
    const mode = input.mode === "update_matching" ? "update_matching" : "insert_only";
    if (!venueId) return { ok: false, message: "請先選擇場館" };
    if (!text.trim()) return { ok: false, message: "請貼上課表文字" };
    if (text.length > 500_000) return { ok: false, message: "匯入文字過大" };
    return { ok: true, venueId, text, mode };
  };

  app.post(
    "/api/admin/schedules/import/preview",
    requireAdminPassword,
    async (req, res) => {
      try {
        const input = readImportRequest(req.body);
        if (!input.ok) return res.status(400).json({ message: input.message });
        const preview = await previewScheduleImport(input.venueId, input.text, input.mode);
        return res.json(preview);
      } catch (error) {
        console.error("Schedule import preview failed:", error);
        return res.status(500).json({ message: "課表匯入預覽失敗" });
      }
    },
  );

  app.post(
    "/api/admin/schedules/import/commit",
    requireAdminPassword,
    async (req, res) => {
      try {
        const input = readImportRequest(req.body);
        if (!input.ok) return res.status(400).json({ message: input.message });
        const result = await commitScheduleImport(input.venueId, input.text, input.mode);
        if (!result.committed) {
          return res.status(409).json({
            message: "資料已變更或仍有錯誤，請重新確認預覽",
            preview: result.preview,
          });
        }
        return res.json(result);
      } catch (error) {
        console.error("Schedule import commit failed:", error);
        return res.status(500).json({ message: "課表匯入失敗，未寫入任何資料" });
      }
    },
  );

  app.post(
    "/api/schedules/copy-week",
    requireAdminPassword,
    async (req, res) => {
      try {
        const { sourceStartDate, sourceEndDate, targetStartDate, venueId, preview } =
          req.body;
        if (!sourceStartDate || !sourceEndDate || !targetStartDate || !venueId) {
          return res.status(400).json({ message: "Missing required fields" });
        }
        if (sourceStartDate === targetStartDate) {
          return res.status(400).json({ message: "來源週與目標週不可相同" });
        }
        const result = await storage.copyWeekIntoEmptyCells({
          sourceStartDate,
          sourceEndDate,
          targetStartDate,
          venueId,
          commit: preview !== true,
        });
        res.json({ success: true, copied: result.committed ? result.plannedCount : 0, ...result });
      } catch (error) {
        console.error("Error copying week:", error);
        if (isPgUniqueViolation(error)) {
          return res.status(409).json({ message: "目標週資料已被其他使用者修改，請重新預覽" });
        }
        res.status(500).json({ message: "Failed to copy week" });
      }
    }
  );

  app.post(
    "/api/schedules/lock",
    requireAdminPassword,
    async (req, res) => {
      try {
        const { venueId, startDate, endDate } = req.body;
        if (!venueId || !startDate || !endDate) {
          return res
            .status(400)
            .json({ message: "Missing venueId, startDate, or endDate" });
        }
        await storage.lockSchedules(venueId, startDate, endDate);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ message: "Failed to lock schedules" });
      }
    }
  );

  app.post(
    "/api/schedules/unlock",
    requireAdminPassword,
    async (req, res) => {
      try {
        const { venueId, startDate, endDate } = req.body;
        if (!venueId || !startDate || !endDate) {
          return res
            .status(400)
            .json({ message: "Missing venueId, startDate, or endDate" });
        }
        await storage.unlockSchedules(venueId, startDate, endDate);
        notifyScheduleUnlocked(venueId, startDate, endDate).catch(() => {});
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ message: "Failed to unlock schedules" });
      }
    }
  );

  app.put(
    "/api/schedules/:id/assign-coach",
    requireAdminPassword,
    async (req, res) => {
      try {
        const { coachName, coachName2, coach1IsTeaching, coach2IsTeaching } =
          req.body;
        const existing = await storage.getScheduleById(req.params.id);
        if (!existing) return res.status(404).json({ message: "Schedule not found" });
        const nextCoach1 = coachName !== undefined ? coachName : existing.coachName;
        const nextCoach2 = coachName2 !== undefined ? coachName2 : existing.coachName2;
        if (isDuplicateCoach(nextCoach1, nextCoach2)) {
          return res.status(400).json({ code: "DUPLICATE_COACH", message: "同一堂課不可指派同一位教練兩次" });
        }

        if (coachName2 !== undefined) {
          if (coachName2 && existing.coachCount < 2) {
            return res.status(400).json({ message: "請先將教練人數設為 2" });
          }
          const updateData: ScheduleUpdate = { coachName2: coachName2 || null };
          if (!coachName2) updateData.coach2IsTeaching = false;
          // Slot 2 filled while slot 1 is empty → that coach moves up to slot 1.
          const promoted = promoteCoachSlots({
            coachName: existing.coachName,
            coachName2: coachName2 || null,
            coach1IsTeaching: !!existing.coach1IsTeaching,
            coach2IsTeaching: !!existing.coach2IsTeaching,
          });
          if (promoted) Object.assign(updateData, promoted);
          const schedule = await storage.updateSchedule(
            req.params.id,
            updateData
          );
          return res.json(schedule);
        }
        if (coach1IsTeaching !== undefined) {
          const schedule = await storage.updateSchedule(req.params.id, {
            coach1IsTeaching: !!coach1IsTeaching,
          });
          return res.json(schedule);
        }
        if (coach2IsTeaching !== undefined) {
          const schedule = await storage.updateSchedule(req.params.id, {
            coach2IsTeaching: !!coach2IsTeaching,
          });
          return res.json(schedule);
        }
        // Clearing slot 1 must not strand a coach in slot 2 — promote them.
        const promoted = promoteCoachSlots({
          coachName: coachName || null,
          coachName2: existing.coachName2,
          coach1IsTeaching: !!existing.coach1IsTeaching,
          coach2IsTeaching: !!existing.coach2IsTeaching,
        });
        const schedule = promoted
          ? await storage.updateSchedule(req.params.id, promoted)
          : await storage.assignCoach(req.params.id, coachName || null);
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ message: "Failed to assign coach" });
      }
    }
  );

  app.put(
    "/api/schedules/:id",
    requireAdminPassword,
    async (req, res) => {
      try {
        const { className, coachName } = req.body;
        const existing = await storage.getScheduleById(req.params.id);
        if (!existing) return res.status(404).json({ message: "Schedule not found" });
        if (isDuplicateCoach(coachName, existing.coachName2)) {
          return res.status(400).json({ code: "DUPLICATE_COACH", message: "同一堂課不可指派同一位教練兩次" });
        }
        const updateData: ScheduleUpdate = { className, coachName };
        const promoted = promoteCoachSlots({
          coachName: coachName !== undefined ? coachName : existing.coachName,
          coachName2: existing.coachName2,
          coach1IsTeaching: !!existing.coach1IsTeaching,
          coach2IsTeaching: !!existing.coach2IsTeaching,
        });
        if (promoted) Object.assign(updateData, promoted);
        const schedule = await storage.updateSchedule(req.params.id, updateData);
        res.json(schedule);
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          return res.status(409).json({ code: "DUPLICATE_CLASS_IN_CELL", message: "此時段已經有相同班級" });
        }
        res.status(500).json({ message: "Failed to update schedule" });
      }
    }
  );

  app.patch(
    "/api/schedules/:id",
    requireAdminPassword,
    async (req, res) => {
      try {
        const {
          coachCount,
          coachName,
          coachName2,
          coach1IsTeaching,
          coach2IsTeaching,
        } = req.body;
        const updateData: ScheduleUpdate = {};
        if (coachCount !== undefined) {
          const count = parseInt(coachCount);
          if (count !== 1 && count !== 2)
            return res
              .status(400)
              .json({ message: "Coach count must be 1 or 2" });
          updateData.coachCount = count;
          if (count === 1) {
            updateData.coachName2 = null;
            updateData.coach2IsTeaching = false;
          }
        }
        if (coachName !== undefined) updateData.coachName = coachName;
        if (coachName2 !== undefined) {
          updateData.coachName2 = coachName2 || null;
          if (!coachName2) updateData.coach2IsTeaching = false;
        }
        if (coach1IsTeaching !== undefined)
          updateData.coach1IsTeaching = !!coach1IsTeaching;
        if (coach2IsTeaching !== undefined)
          updateData.coach2IsTeaching = !!coach2IsTeaching;
        const existing = await storage.getScheduleById(req.params.id);
        if (!existing) return res.status(404).json({ message: "Schedule not found" });
        const nextCoach1 = updateData.coachName !== undefined ? updateData.coachName : existing.coachName;
        const nextCoach2 = updateData.coachName2 !== undefined ? updateData.coachName2 : existing.coachName2;
        if (isDuplicateCoach(nextCoach1, nextCoach2)) {
          return res.status(400).json({ code: "DUPLICATE_COACH", message: "同一堂課不可指派同一位教練兩次" });
        }
        // Never leave slot 2 filled while slot 1 is empty. The candidate is
        // read before the coachCount=1 rule nulls slot 2, so dropping to one
        // coach keeps the only coach on the card instead of deleting them.
        const promoted = promoteCoachSlots({
          coachName: nextCoach1 ?? null,
          coachName2: coachName2 !== undefined ? coachName2 || null : existing.coachName2,
          coach1IsTeaching: updateData.coach1IsTeaching ?? !!existing.coach1IsTeaching,
          coach2IsTeaching: updateData.coach2IsTeaching ?? !!existing.coach2IsTeaching,
        });
        if (promoted) Object.assign(updateData, promoted);
        const schedule = await storage.updateSchedule(
          req.params.id,
          updateData
        );
        res.json(schedule);
      } catch (error) {
        if (isPgUniqueViolation(error)) {
          return res.status(409).json({ code: "DUPLICATE_CLASS_IN_CELL", message: "此時段已經有相同班級" });
        }
        res.status(500).json({ message: "Failed to update schedule" });
      }
    }
  );

  app.delete(
    "/api/schedules/:id",
    requireAdminPassword,
    async (req, res) => {
      try {
        const existing = await storage.getScheduleById(req.params.id);
        if (existing?.isClassLocked) {
          return res
            .status(409)
            .json({ message: "課表已鎖定，請先解鎖該週才能刪除" });
        }
        await storage.deleteSchedule(req.params.id);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ message: "Failed to delete schedule" });
      }
    }
  );

  // Vacant schedules — has className but no coachName, filtered by venue+week
  app.get("/api/schedules/vacant", async (req, res) => {
    try {
      const { venueId, startDate, endDate } = req.query as {
        venueId: string;
        startDate: string;
        endDate: string;
      };
      if (!venueId || !startDate || !endDate) {
        return res.status(400).json({ message: "Missing parameters" });
      }
      const result = await storage.getVacantSchedules(venueId, startDate, endDate);
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch vacant schedules" });
    }
  });

  // `/:date` MUST come last so Express tries every static path above first.
  // (Schedule date strings collide with names like "lock-status" otherwise.)
  app.get("/api/schedules/:date", async (req, res) => {
    try {
      const { date } = req.params;
      const schedules = await storage.getSchedulesByDate(date);
      res.json(schedules);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch schedules" });
    }
  });

  // Conflicts
  app.get("/api/conflicts/:date", async (req, res) => {
    try {
      const { date } = req.params;
      const conflicts = await storage.getConflicts(date);
      res.json(conflicts);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch conflicts" });
    }
  });

  // Statistics
  app.get("/api/statistics", async (req, res) => {
    try {
      const { startDate, endDate, coachName } = req.query as {
        startDate: string;
        endDate: string;
        coachName?: string;
      };
      const statistics = await storage.getCoachStatistics(
        startDate,
        endDate,
        coachName
      );
      res.json(statistics);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch statistics" });
    }
  });
}
