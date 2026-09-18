/**
 * Venue + TimeSlot + VenueInfo repository.
 *
 * Owns every direct DB read/write for the three closely related catalog
 * tables. The IStorage façade in `server/storage.ts` simply delegates
 * its venue-shaped methods here.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { lockScheduleWrites } from "../shared/scheduleMutation";
import { audit, MutationError } from "../shared/audit";
import {
  venues,
  timeSlots,
  venueInfos,
  schedules,
  coachVenuePreferences,
  type Venue,
  type TimeSlot,
  type VenueInfo,
} from "@shared/schema";

export class VenueRepository {
  async getVenues(): Promise<Venue[]> {
    return await db.select().from(venues).orderBy(venues.order);
  }

  async createVenue(name: string, color: string): Promise<Venue> {
    return db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const existing = await tx.select().from(venues);
      if (existing.some(v => v.name === name)) throw new MutationError("VENUE_EXISTS");
      const [venue] = await tx.insert(venues).values({ name, color, order: Math.max(0, ...existing.map(v => v.order)) + 1 }).returning();
      await audit(tx, "venue", venue.id, null, venue);
      return venue;
    });
  }
  async deleteVenue(id: string): Promise<void> {
    await db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const [venue] = await tx.select().from(venues).where(eq(venues.id, id)).for("update");
      if (!venue) throw new MutationError("VENUE_NOT_FOUND", 404);
      const linked = await tx.select({ id: schedules.id }).from(schedules).where(eq(schedules.venueId, id)).limit(1);
      if (linked.length) throw new MutationError("VENUE_HAS_SCHEDULE_HISTORY");
      await tx.delete(venueInfos).where(eq(venueInfos.venueName, venue.name));
      await tx.delete(coachVenuePreferences).where(eq(coachVenuePreferences.venueName, venue.name));
      await tx.delete(venues).where(eq(venues.id, id));
      await audit(tx, "venue", id, venue, null);
    });
  }

  async initializeVenues(): Promise<void> {
    const existingVenues = await this.getVenues();
    if (existingVenues.length === 0) {
      const defaultVenues = [
        { name: "新北高中", color: "blue", order: 1 },
        { name: "三重商工", color: "green", order: 2 },
        { name: "三民高中", color: "purple", order: 3 },
        { name: "福林國小", color: "yellow", order: 4 },
        { name: "新莊國中", color: "orange", order: 5 },
        { name: "清江國小", color: "teal", order: 6 },
        { name: "松山國小", color: "red", order: 7 },
      ];
      await db.insert(venues).values(defaultVenues);
      console.log("✅ Default venues initialized");
    }
  }

  async getTimeSlots(): Promise<TimeSlot[]> {
    return await db.select().from(timeSlots).orderBy(timeSlots.order);
  }

  async initializeTimeSlots(): Promise<void> {
    const existingSlots = await this.getTimeSlots();
    if (existingSlots.length === 0) {
      const defaultTimeSlots = [
        { period: "第1節", startTime: "08", endTime: "09", order: 1 },
        { period: "第2節", startTime: "09", endTime: "10", order: 2 },
        { period: "第3節", startTime: "10", endTime: "11", order: 3 },
        { period: "第4節", startTime: "11", endTime: "12", order: 4 },
        { period: "第5節", startTime: "13", endTime: "14", order: 5 },
        { period: "第6節", startTime: "14", endTime: "15", order: 6 },
        { period: "第7節", startTime: "15", endTime: "16", order: 7 },
      ];
      await db.insert(timeSlots).values(defaultTimeSlots);
    }
  }

  async getAllVenueInfos(): Promise<VenueInfo[]> {
    return await db.select().from(venueInfos).orderBy(venueInfos.venueName);
  }

  async getVenueInfo(venueName: string): Promise<VenueInfo | undefined> {
    const [result] = await db
      .select()
      .from(venueInfos)
      .where(eq(venueInfos.venueName, venueName));
    return result;
  }

  async upsertVenueInfo(
    venueName: string,
    videoUrl: string | null,
    description: string | null,
    mapUrl?: string | null
  ): Promise<VenueInfo> {
    return db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const [before] = await tx.select().from(venueInfos).where(eq(venueInfos.venueName, venueName));
    const [result] = await tx
      .insert(venueInfos)
      .values({
        venueName,
        videoUrl,
        description,
        mapUrl: mapUrl ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: venueInfos.venueName,
        set: {
          videoUrl,
          description,
          mapUrl: mapUrl ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    await audit(tx, "venue_info", result.id, before, result);
    return result;
    });
  }
}
