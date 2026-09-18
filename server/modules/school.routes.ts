import type { Express, Request, Response, NextFunction } from "express";
import {
  initializeSchoolSchema,
  isValidSchoolCode,
  getAvailableSchools,
  getSchoolPublicInfo,
} from "../multi-school-db";
import * as schoolRepo from "./school.repo";
import { env } from "../config/env";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import {
  createTeacherAccessToken,
  listTeacherAccessTokens,
  listTeacherAccessAuditLogs,
  requireTeacherIdentity,
  revokeTeacherAccessToken,
  TEACHER_PERMISSIONS,
  type TeacherIdentityRequest,
  type TeacherPermission,
} from "../shared/auth/teacherIdentity";
import { z } from "zod";

/**
 * Defence-in-depth: schoolCode must pass BOTH the regex (no SQL-unsafe chars)
 * AND the whitelist of registered schools. Either fail short-circuits.
 */
const validateSchoolCode = (req: Request, res: Response, next: NextFunction) => {
  const { schoolCode } = req.params;
  if (!isValidSchoolCode(schoolCode)) {
    return res.status(400).json({ message: "Invalid school code" });
  }
  if (!getAvailableSchools().includes(schoolCode)) {
    return res.status(404).json({ message: "Unknown school code" });
  }
  next();
};

export function registerSchoolRoutes(app: Express): void {
  app.get("/api/admin/schools", requireAdminPassword, (_req, res) => {
    res.json({ schools: getAvailableSchools().map(getSchoolPublicInfo) });
  });
  app.get("/api/:schoolCode/public-info", validateSchoolCode, (req, res) => {
    res.json(getSchoolPublicInfo(req.params.schoolCode));
  });

  app.get(
    "/api/:schoolCode/teacher/me",
    validateSchoolCode,
    requireTeacherIdentity("feedback:read"),
    (req: TeacherIdentityRequest, res) => res.json(req.teacherIdentity),
  );

  app.get(
    "/api/:schoolCode/teacher/schedules",
    validateSchoolCode,
    requireTeacherIdentity("feedback:read"),
    async (req: TeacherIdentityRequest, res) => {
      const identity = req.teacherIdentity!;
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const list = await schoolRepo.listSchedules(identity.schoolCode, {
        teacher: identity.teacherName,
        startDate,
        endDate,
      });
      res.json(list);
    },
  );
  app.post("/api/admin/init-school/:schoolCode", requireAdminPassword, async (req, res) => {
    try {
      const { schoolCode } = req.params;
      if (!isValidSchoolCode(schoolCode)) {
        return res.status(400).json({ message: "Invalid school code" });
      }
      await initializeSchoolSchema(schoolCode);
      res.json({ message: `School ${schoolCode} initialized successfully` });
    } catch (error) {
      console.error("Error initializing school:", error);
      res.status(500).json({ message: "Failed to initialize school" });
    }
  });

  app.post("/api/admin/import-schedule/:schoolCode", requireAdminPassword, async (req, res) => {
    try {
      const { schoolCode } = req.params;
      if (!isValidSchoolCode(schoolCode)) {
        return res.status(400).json({ message: "Invalid school code" });
      }
      const { importScheduleData } = await import("../import-schedule");
      const count = await importScheduleData();
      res.json({
        message: `Successfully imported ${count} schedule records`,
        count,
      });
    } catch (error) {
      console.error("Error importing schedule:", error);
      res.status(500).json({ message: "Failed to import schedule data" });
    }
  });

  app.get("/api/:schoolCode/teachers", validateSchoolCode, requireAdminPassword, async (req, res) => {
    try {
      const teachers = await schoolRepo.listTeachers(req.params.schoolCode);
      console.log(
        `✅ Fetched ${teachers.length} teachers for school ${req.params.schoolCode}`
      );
      res.json(teachers);
    } catch (error) {
      console.error("Error fetching teachers:", error);
      res.status(500).json({ message: "Failed to fetch teachers" });
    }
  });

  // Per-school endpoints that simply mirror the shared catalog
  app.get("/api/:schoolCode/time-slots", validateSchoolCode, async (_req, res) => {
    try {
      const { storage } = await import("../storage");
      const timeSlots = await storage.getTimeSlots();
      res.json(timeSlots);
    } catch (error) {
      console.error("Error fetching time slots:", error);
      res.status(500).json({ message: "Failed to fetch time slots" });
    }
  });

  app.get("/api/:schoolCode/venues", validateSchoolCode, async (_req, res) => {
    try {
      const { storage } = await import("../storage");
      const venues = await storage.getVenues();
      res.json(venues);
    } catch (error) {
      console.error("Error fetching venues:", error);
      res.status(500).json({ message: "Failed to fetch venues" });
    }
  });

  app.get("/api/:schoolCode/schedules", validateSchoolCode, async (req, res) => {
    try {
      const { teacher, startDate, endDate } = req.query as {
        teacher?: string;
        startDate?: string;
        endDate?: string;
      };
      const list = await schoolRepo.listSchedules(req.params.schoolCode, {
        teacher,
        startDate,
        endDate,
      });
      res.json(list);
    } catch (error) {
      console.error("Error fetching school schedules:", error);
      res.status(500).json({ message: "Failed to fetch schedules" });
    }
  });

  app.get("/api/:schoolCode/feedbacks", validateSchoolCode, requireTeacherIdentity("feedback:read"), async (req: TeacherIdentityRequest, res) => {
    try {
      const { scheduleId } = req.query as {
        scheduleId?: string;
      };
      const list = await schoolRepo.listFeedbacks(req.params.schoolCode, {
        teacherId: req.teacherIdentity!.teacherId,
        scheduleId,
      });
      res.json(list);
    } catch (error) {
      console.error("Error fetching teacher feedbacks:", error);
      res.status(500).json({ message: "Failed to fetch feedbacks" });
    }
  });

  app.post("/api/:schoolCode/feedbacks", validateSchoolCode, requireTeacherIdentity("feedback:write"), async (req: TeacherIdentityRequest, res) => {
    const isDeployment = env.isDeployment;
    const { schoolCode } = req.params;

    try {
      if (!process.env.DATABASE_URL) {
        console.error("❌ 資料庫未配置");
        return res.status(503).json({
          message: "Database not configured",
          error: "Please set up DATABASE_URL environment variable",
          isDeployment,
          setupRequired: true,
        });
      }

      if (isDeployment) {
        console.log("🚀 PRODUCTION: Saving feedback for school:", schoolCode);
      }

      if (!req.body.scheduleId || req.body.scheduleId.length < 10) {
        return res
          .status(400)
          .json({ message: "Invalid schedule ID - ID is required" });
      }

      const validation = z.object({
        scheduleId: z.string().min(10),
        status: z.enum(["need_coop", "no_coop", "reschedule"]),
        rescheduleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        reschedulePeriod: z.string().max(50).nullish(),
        comment: z.string().max(2000).nullish(),
      }).safeParse(req.body);
      if (!validation.success) {
        console.error("❌ Validation failed:", validation.error.issues);
        return res.status(400).json({
          message: "Invalid feedback data",
          errors: validation.error.issues,
        });
      }

      const feedbackData = validation.data;
      const identity = req.teacherIdentity!;
      if (feedbackData.status === "reschedule") {
        if (!feedbackData.rescheduleDate || !feedbackData.reschedulePeriod) {
          return res.status(400).json({
            message:
              "Reschedule date and period are required when status is reschedule",
          });
        }
      }

      const canAccess = await schoolRepo.teacherCanAccessSchedule(
        schoolCode,
        feedbackData.scheduleId,
        identity.teacherName,
      );
      if (!canAccess) {
        return res.status(403).json({
          code: "teacher_schedule_denied",
          message: "您無權回覆這堂課",
        });
      }

      const saved = await schoolRepo.upsertFeedback(schoolCode, {
        scheduleId: feedbackData.scheduleId,
        teacherId: identity.teacherId,
        teacherName: identity.teacherName,
        status: feedbackData.status,
        rescheduleDate: feedbackData.rescheduleDate || null,
        reschedulePeriod: feedbackData.reschedulePeriod || null,
        comment: feedbackData.comment || null,
      });

      res.json(saved);
    } catch (error) {
      console.error("💥 ERROR: Failed to save teacher feedback:", error);
      res.status(500).json({
        message: "Failed to save feedback",
        error: isDeployment
          ? error instanceof Error
            ? error.message
            : String(error)
          : "Database error",
        schoolCode,
        when: new Date().toISOString(),
      });
    }
  });

  app.get(
    "/api/admin/:schoolCode/feedbacks",
    validateSchoolCode,
    requireAdminPassword,
    async (req, res) => {
      const { teacherId, scheduleId } = req.query as { teacherId?: string; scheduleId?: string };
      res.json(await schoolRepo.listFeedbacks(req.params.schoolCode, { teacherId, scheduleId }));
    },
  );

  app.get(
    "/api/admin/:schoolCode/teacher-links",
    validateSchoolCode,
    requireAdminPassword,
    async (req, res) => res.json({ links: await listTeacherAccessTokens(req.params.schoolCode) }),
  );

  app.get(
    "/api/admin/:schoolCode/teacher-links/audit",
    requireAdminPassword,
    async (req, res) => res.json({
      logs: await listTeacherAccessAuditLogs(
        req.params.schoolCode,
        Number(req.query.limit) || 200,
      ),
    }),
  );

  app.post(
    "/api/admin/:schoolCode/teacher-links",
    validateSchoolCode,
    requireAdminPassword,
    async (req, res) => {
      const parsed = z.object({
        teacherId: z.string().min(1),
        permissions: z.array(z.enum(TEACHER_PERMISSIONS)).min(1),
        expiresAt: z.string().datetime(),
      }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "連結資料格式錯誤", issues: parsed.error.issues });
      try {
        const created = await createTeacherAccessToken({
          schoolCode: req.params.schoolCode,
          teacherId: parsed.data.teacherId,
          permissions: parsed.data.permissions as TeacherPermission[],
          expiresAt: new Date(parsed.data.expiresAt),
        });
        const url = `${env.publicOrigin}/teacher/${encodeURIComponent(req.params.schoolCode)}?token=${encodeURIComponent(created.token)}`;
        res.status(201).json({ link: created.record, teacher: created.teacher, url });
      } catch (error) {
        res.status(400).json({ message: error instanceof Error ? error.message : "建立連結失敗" });
      }
    },
  );

  app.post(
    "/api/admin/:schoolCode/teacher-links/:id/revoke",
    validateSchoolCode,
    requireAdminPassword,
    async (req, res) => {
      const links = await listTeacherAccessTokens(req.params.schoolCode);
      if (!links.some((link) => link.id === req.params.id)) return res.status(404).json({ message: "找不到連結" });
      await revokeTeacherAccessToken(req.params.id);
      res.json({ success: true });
    },
  );

  app.post("/api/:schoolCode/schedules", validateSchoolCode, requireAdminPassword, async (req, res) => {
    try {
      const result = await schoolRepo.createSchoolSchedule(
        req.params.schoolCode,
        req.body
      );
      if (!result.ok) {
        return res
          .status(400)
          .json({ message: "Invalid schedule data", errors: result.errors });
      }
      res.json(result.schedule);
    } catch (error) {
      console.error("Error adding schedule:", error);
      res.status(500).json({ message: "Failed to add schedule" });
    }
  });

  app.delete(
    "/api/:schoolCode/schedules/:scheduleId",
    validateSchoolCode,
    requireAdminPassword,
    async (req, res) => {
      try {
        const ok = await schoolRepo.deleteSchoolSchedule(
          req.params.schoolCode,
          req.params.scheduleId
        );
        if (!ok) {
          return res.status(404).json({ message: "Schedule not found" });
        }
        res.json({ message: "Schedule deleted successfully" });
      } catch (error) {
        console.error("Error deleting schedule:", error);
        res.status(500).json({ message: "Failed to delete schedule" });
      }
    }
  );
}
