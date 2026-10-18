/**
 * Coach repository — coach user accounts (LINE-based registration),
 * weekly availability matrix, venue preferences and same-slot colleague
 * lookups. The IStorage façade in `server/storage.ts` delegates here.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
// #3: follows the caller's transaction (see shared/dbContext).
import { txDb as db } from "../shared/dbContext";
import {
  coachUsers,
  coachAvailability,
  coachVenuePreferences,
  schedules,
  type CoachUser,
  type InsertCoachUserType,
  type CoachAvailability,
  type CoachVenuePreference,
} from "@shared/schema";

export class CoachRepository {
  async getCoachUserByLineId(lineId: string): Promise<CoachUser | undefined> {
    const [user] = await db
      .select()
      .from(coachUsers)
      .where(eq(coachUsers.lineId, lineId));
    return user;
  }

  async getCoachUserById(id: string): Promise<CoachUser | undefined> {
    const [user] = await db
      .select()
      .from(coachUsers)
      .where(eq(coachUsers.id, id));
    return user;
  }

  async createCoachUser(data: InsertCoachUserType): Promise<CoachUser> {
    const [user] = await db.insert(coachUsers).values(data).returning();
    return user;
  }

  async updateCoachUserStatus(id: string, status: string): Promise<CoachUser> {
    const [user] = await db
      .update(coachUsers)
      .set({ status, updatedAt: new Date() })
      .where(eq(coachUsers.id, id))
      .returning();
    return user;
  }

  async updateCoachUserLineId(
    id: string,
    lineId: string
  ): Promise<CoachUser | undefined> {
    const [user] = await db
      .update(coachUsers)
      .set({ lineId, updatedAt: new Date() })
      .where(eq(coachUsers.id, id))
      .returning();
    return user;
  }

  async clearCoachUserLineId(id: string): Promise<CoachUser | undefined> {
    const [user] = await db
      .update(coachUsers)
      .set({ lineId: null, updatedAt: new Date() })
      .where(eq(coachUsers.id, id))
      .returning();
    return user;
  }

  async updateCoachUserName(
    id: string,
    name: string
  ): Promise<CoachUser | undefined> {
    const [user] = await db
      .update(coachUsers)
      .set({ name, updatedAt: new Date() })
      .where(eq(coachUsers.id, id))
      .returning();
    return user;
  }

  async updateCoachEmployeeId(
    id: string,
    employeeId: string
  ): Promise<CoachUser | undefined> {
    const [user] = await db
      .update(coachUsers)
      .set({ employeeId, updatedAt: new Date() })
      .where(eq(coachUsers.id, id))
      .returning();
    return user;
  }

  async getAllCoachUsers(): Promise<CoachUser[]> {
    return await db
      .select()
      .from(coachUsers)
      .orderBy(
        sql`CASE WHEN ${coachUsers.name} = '陳柏榮' THEN 0 ELSE 1 END`,
        coachUsers.name
      );
  }

  async getPendingCoachUsers(): Promise<CoachUser[]> {
    return await db
      .select()
      .from(coachUsers)
      .where(eq(coachUsers.status, "pending"))
      .orderBy(desc(coachUsers.createdAt));
  }

  async getApprovedCoachUsers(): Promise<CoachUser[]> {
    return await db
      .select()
      .from(coachUsers)
      .where(eq(coachUsers.status, "approved"))
      .orderBy(coachUsers.name);
  }

  async getColleaguesForCoach(
    coachName: string,
    date: string,
    venueIds: string[]
  ): Promise<{ name: string; phone: string | null }[]> {
    if (venueIds.length === 0) return [];

    const sameVenueSchedules = await db
      .select({ coachName: schedules.coachName, coachName2: schedules.coachName2 })
      .from(schedules)
      .where(
        and(
          eq(schedules.date, date),
          inArray(schedules.venueId, venueIds)
        )
      );

    // Collect all coach names from both coach slots, excluding self
    const colleagueNameSet = new Set<string>();
    for (const s of sameVenueSchedules) {
      if (s.coachName && s.coachName !== coachName) colleagueNameSet.add(s.coachName);
      if (s.coachName2 && s.coachName2 !== coachName) colleagueNameSet.add(s.coachName2);
    }
    const colleagueNames = Array.from(colleagueNameSet);

    if (colleagueNames.length === 0) return [];

    const colleagues: { name: string; phone: string | null }[] = [];
    for (const name of colleagueNames) {
      const [coachUser] = await db
        .select({ name: coachUsers.name, phone: coachUsers.phone })
        .from(coachUsers)
        .where(eq(coachUsers.name, name));
      colleagues.push({ name, phone: coachUser?.phone || null });
    }
    return colleagues;
  }

  async getCoachAvailabilityByWeek(weekStart: string): Promise<CoachAvailability[]> {
    return await db
      .select()
      .from(coachAvailability)
      .where(eq(coachAvailability.weekStart, weekStart));
  }

  async getCoachAvailabilityForCoach(
    coachName: string,
    weekStart: string
  ): Promise<CoachAvailability[]> {
    return await db
      .select()
      .from(coachAvailability)
      .where(
        and(
          eq(coachAvailability.coachName, coachName),
          eq(coachAvailability.weekStart, weekStart)
        )
      );
  }

  async upsertCoachAvailability(
    coachName: string,
    weekStart: string,
    slots: { dayOfWeek: number; timeSlotOrder: number }[]
  ): Promise<void> {
    await db
      .delete(coachAvailability)
      .where(
        and(
          eq(coachAvailability.coachName, coachName),
          eq(coachAvailability.weekStart, weekStart)
        )
      );
    if (slots.length > 0) {
      await db.insert(coachAvailability).values(
        slots.map((s) => ({
          coachName,
          weekStart,
          dayOfWeek: s.dayOfWeek,
          timeSlotOrder: s.timeSlotOrder,
        }))
      );
    }
  }

  async getCoachVenuePreferences(
    coachName: string
  ): Promise<CoachVenuePreference[]> {
    return await db
      .select()
      .from(coachVenuePreferences)
      .where(eq(coachVenuePreferences.coachName, coachName));
  }

  async getAllCoachVenuePreferences(): Promise<CoachVenuePreference[]> {
    return await db.select().from(coachVenuePreferences);
  }

  async setCoachVenuePreferences(
    coachName: string,
    venueNames: string[]
  ): Promise<void> {
    await db
      .delete(coachVenuePreferences)
      .where(eq(coachVenuePreferences.coachName, coachName));
    if (venueNames.length > 0) {
      await db.insert(coachVenuePreferences).values(
        venueNames.map((venueName) => ({ coachName, venueName }))
      );
    }
  }

  /**
   * Returns availability-slot count and venue-preference count for one
   * coach. Used by both the admin fill-rate dashboard and the coach-portal
   * fill-status badge so the SQL lives in one place.
   */
  async getCoachFillStatus(
    coachName: string
  ): Promise<{ availabilitySlots: number; venuePrefsCount: number }> {
    const [availRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(coachAvailability)
      .where(eq(coachAvailability.coachName, coachName));
    const [prefsRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(coachVenuePreferences)
      .where(eq(coachVenuePreferences.coachName, coachName));
    return {
      availabilitySlots: availRow?.count ?? 0,
      venuePrefsCount: prefsRow?.count ?? 0,
    };
  }
}
