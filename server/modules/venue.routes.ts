import type { Express } from "express";
import { storage } from "../storage";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { inTransaction } from "../shared/dbContext";
import { ADMIN_ACTOR, recordAudit, requestIdOf } from "../shared/audit";

export function registerVenueRoutes(app: Express): void {
  app.get("/api/venues", async (_req, res) => {
    try {
      const venues = await storage.getVenues();
      res.json(venues);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch venues" });
    }
  });

  app.post("/api/admin/venues", requireAdminPassword, async (req, res) => {
    try {
      const { name, color } = req.body;
      if (!name || !color) {
        return res.status(400).json({ message: "Name and color are required" });
      }
      const existingVenues = await storage.getVenues();
      if (existingVenues.some((v) => v.name === name)) {
        return res.status(400).json({ message: "場館名稱已存在" });
      }
      const venue = await inTransaction(async () => {
        const created = await storage.createVenue(name, color);
        await recordAudit({
          actor: ADMIN_ACTOR,
          requestId: requestIdOf(req),
          action: "venue.create",
          entity: "venue",
          entityId: created.id,
          after: { name: created.name, color: created.color },
          reason: created.name,
        });
        return created;
      });
      res.json(venue);
    } catch (error) {
      console.error("Error creating venue:", error);
      res.status(500).json({ message: "Failed to create venue" });
    }
  });

  app.delete("/api/admin/venues/:id", requireAdminPassword, async (req, res) => {
    try {
      // Deleting a venue also deletes its schedules (venue repository).
      const venue = (await storage.getVenues()).find((v) => v.id === req.params.id);
      await inTransaction(async () => {
        await storage.deleteVenue(req.params.id);
        await recordAudit({
          actor: ADMIN_ACTOR,
          requestId: requestIdOf(req),
          action: "venue.delete",
          entity: "venue",
          entityId: req.params.id,
          before: venue ? { name: venue.name, color: venue.color } : null,
          reason: venue ? `${venue.name}（連同該場館課程）` : null,
        });
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting venue:", error);
      res.status(500).json({ message: "Failed to delete venue" });
    }
  });

  // Venue info (descriptions / map / video links)
  app.get("/api/venue-infos", async (_req, res) => {
    try {
      const infos = await storage.getAllVenueInfos();
      res.json(infos);
    } catch (error) {
      console.error("Error fetching venue infos:", error);
      res.status(500).json({ message: "查詢場館資訊失敗" });
    }
  });

  app.put(
    "/api/admin/venue-infos/:venueName",
    requireAdminPassword,
    async (req, res) => {
      try {
        const { venueName } = req.params;
        const { videoUrl, description, mapUrl } = req.body;
        const name = decodeURIComponent(venueName);
        const previous = (await storage.getAllVenueInfos()).find((i) => i.venueName === name);
        const info = await inTransaction(async () => {
          const saved = await storage.upsertVenueInfo(
            name,
            videoUrl || null,
            description || null,
            mapUrl || null
          );
          const pick = (i: typeof saved | undefined) =>
            i ? { videoUrl: i.videoUrl, description: i.description, mapUrl: i.mapUrl } : null;
          await recordAudit({
            actor: ADMIN_ACTOR,
            requestId: requestIdOf(req),
            action: "venue_info.update",
            entity: "venue_info",
            entityId: name,
            before: pick(previous),
            after: pick(saved),
            reason: name,
          });
          return saved;
        });
        res.json(info);
      } catch (error) {
        console.error("Error updating venue info:", error);
        res.status(500).json({ message: "更新場館資訊失敗" });
      }
    }
  );
}
