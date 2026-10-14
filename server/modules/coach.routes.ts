import type { Express } from "express";
import { storage } from "../storage";
import { insertCoachRegistrationSchema } from "@shared/schema";
import { requireAdminPassword } from "../shared/auth/adminPassword";

export function registerCoachRoutes(app: Express): void {
  app.get("/api/coach-schedules", async (req, res) => {
    try {
      const { startDate, endDate, coachName } = req.query as {
        startDate: string;
        endDate: string;
        coachName?: string;
      };
      if (!coachName) {
        return res.status(400).json({ message: "Coach name is required" });
      }
      const schedules = await storage.getCoachSchedules(
        coachName,
        startDate,
        endDate
      );
      res.json(schedules);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch coach schedules" });
    }
  });

  app.get("/api/coaches", async (_req, res) => {
    try {
      const coaches = await storage.getUniqueCoaches();
      res.json(coaches);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch coaches" });
    }
  });

  app.get("/api/approved-coaches", requireAdminPassword, async (_req, res) => {
    try {
      const approvedUsers = await storage.getApprovedCoachUsers();
      const names = approvedUsers
        .map((u) => u.linkedCoachName || u.name)
        .filter(Boolean);
      res.json(names);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch approved coaches" });
    }
  });

  // Schedules without a coach assigned (with optional date range)
  app.get("/api/schedules-without-coach", async (req, res) => {
    try {
      const { startDate, endDate } = req.query as {
        startDate?: string;
        endDate?: string;
      };
      const schedules =
        startDate && endDate
          ? await storage.getSchedulesWithoutCoachByDateRange(startDate, endDate)
          : await storage.getSchedulesWithoutCoach();
      res.json(schedules);
    } catch (error) {
      console.error("Error fetching schedules without coach:", error);
      res
        .status(500)
        .json({ message: "Failed to fetch schedules without coach" });
    }
  });

  // Coach registrations (apply for an open class)
  app.post("/api/coach-registrations", async (req, res) => {
    try {
      const validation = insertCoachRegistrationSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          message: "Invalid registration data",
          errors: validation.error.issues,
        });
      }
      const registration = await storage.registerCoachForSchedule(
        validation.data
      );
      res.json(registration);
    } catch (error) {
      console.error("Error registering coach:", error);
      res.status(500).json({ message: "Failed to register coach" });
    }
  });

  app.get("/api/coach-registrations/:scheduleId", async (req, res) => {
    try {
      const { scheduleId } = req.params;
      const registrations = await storage.getCoachRegistrations(scheduleId);
      res.json(registrations);
    } catch (error) {
      console.error("Error fetching coach registrations:", error);
      res.status(500).json({ message: "Failed to fetch coach registrations" });
    }
  });

  // === Coach availability (admin / public read views) ===
  app.get("/api/coach-availability", async (req, res) => {
    try {
      const { weekStart } = req.query as { weekStart: string };
      if (!weekStart) {
        return res.status(400).json({ message: "Missing weekStart parameter" });
      }
      const availability = await storage.getCoachAvailabilityByWeek(weekStart);
      res.json(availability);
    } catch (error) {
      console.error("Error fetching coach availability:", error);
      res.status(500).json({ message: "Failed to fetch coach availability" });
    }
  });

  app.get(
    "/api/admin/coach-venue-preferences",
    requireAdminPassword,
    async (_req, res) => {
      try {
        const allPrefs = await storage.getAllCoachVenuePreferences();
        const grouped: Record<string, string[]> = {};
        allPrefs.forEach((p) => {
          if (!grouped[p.coachName]) grouped[p.coachName] = [];
          grouped[p.coachName].push(p.venueName);
        });
        res.json(grouped);
      } catch (error) {
        console.error("Error fetching all venue preferences:", error);
        res.status(500).json({ message: "Failed to fetch venue preferences" });
      }
    }
  );

  // Public: coach rules (read)
  app.get("/api/settings/coach-rules", async (_req, res) => {
    try {
      const value = await storage.getSetting("coach_rules");
      res.json({ content: value || "" });
    } catch (error) {
      console.error("Error fetching coach rules:", error);
      res.status(500).json({ message: "查詢教練守則失敗" });
    }
  });
}
