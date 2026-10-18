/**
 * Venue + TimeSlot + VenueInfo repository.
 *
 * Owns every direct DB read/write for the three closely related catalog
 * tables. The IStorage façade in `server/storage.ts` simply delegates
 * its venue-shaped methods here.
 */
import { eq } from "drizzle-orm";
// #3: follows the caller's transaction (see shared/dbContext).
import { txDb as db } from "../shared/dbContext";
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
    const existing = await this.getVenues();
    const maxOrder =
      existing.length > 0 ? Math.max(...existing.map((v) => v.order)) : 0;
    const [venue] = await db
      .insert(venues)
      .values({ name, color, order: maxOrder + 1 })
      .returning();
    return venue;
  }

  async deleteVenue(id: string): Promise<void> {
    const venue = await db.select().from(venues).where(eq(venues.id, id));
    if (venue.length > 0) {
      await db
        .delete(venueInfos)
        .where(eq(venueInfos.venueName, venue[0].name));
      await db
        .delete(coachVenuePreferences)
        .where(eq(coachVenuePreferences.venueName, venue[0].name));
    }
    await db.delete(schedules).where(eq(schedules.venueId, id));
    await db.delete(venues).where(eq(venues.id, id));
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
    const [result] = await db
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
    return result;
  }
}
