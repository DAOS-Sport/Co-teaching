/**
 * Coach repository — coach user accounts (LINE-based registration),
 * weekly availability matrix, venue preferences and same-slot colleague
 * lookups. The IStorage façade in `server/storage.ts` delegates here.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { resolveCoach, lockScheduleWrites } from "../shared/scheduleMutation";
import { audit, MutationError } from "../shared/audit";
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
    return db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const [before] = await tx.select().from(coachUsers).where(eq(coachUsers.id, id)).for("update");
      if (!before) return undefined;
      if (before.lineId && before.lineId !== lineId) throw new MutationError("COACH_LINE_ID_CONFLICT");
      const [user] = await tx.update(coachUsers).set({ lineId, updatedAt: new Date() }).where(eq(coachUsers.id, id)).returning();
      await audit(tx, "coach_line_binding", id, { linked: !!before.lineId }, { linked: true });
      return user;
    });
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
    return db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const [before] = await tx.select().from(coachUsers).where(eq(coachUsers.id, id)).for("update");
      if (!before) return undefined;
      const [user] = await tx.update(coachUsers).set({ name, updatedAt: new Date() }).where(eq(coachUsers.id, id)).returning();
      await audit(tx, "coach_name", id, { name: before.name }, { name });
      return user;
    });
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

  async getCoachAvailabilityForCoach(coachName: string, weekStart: string, coachUserId?: string): Promise<CoachAvailability[]> {
    return db.transaction(async tx => {
      const coach = (await resolveCoach(tx, coachName, coachUserId))!;
      return tx.select().from(coachAvailability).where(and(eq(coachAvailability.coachUserId, coach.id), eq(coachAvailability.weekStart, weekStart)));
    });
  }

  async upsertCoachAvailability(coachName: string, weekStart: string, slots: { dayOfWeek: number; timeSlotOrder: number }[], coachUserId?: string): Promise<void> {
    await db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const coach = (await resolveCoach(tx, coachName, coachUserId))!;
      const where = and(eq(coachAvailability.coachUserId, coach.id), eq(coachAvailability.weekStart, weekStart));
      const before = await tx.select().from(coachAvailability).where(where);
      await tx.delete(coachAvailability).where(where);
      if (slots.length) await tx.insert(coachAvailability).values(slots.map(s => ({ coachUserId: coach.id, coachName: coach.name, weekStart, dayOfWeek: s.dayOfWeek, timeSlotOrder: s.timeSlotOrder })));
      const after = await tx.select().from(coachAvailability).where(where);
      await audit(tx, "coach_availability", coach.id + ":" + weekStart, before, after);
    });
  }

  async getCoachVenuePreferences(
    coachName: string,
    coachUserId?: string
  ): Promise<CoachVenuePreference[]> {
    return await db
      .select()
      .from(coachVenuePreferences)
      .where(coachUserId ? eq(coachVenuePreferences.coachUserId, coachUserId) : eq(coachVenuePreferences.coachName, coachName));
  }

  async getAllCoachVenuePreferences(): Promise<CoachVenuePreference[]> {
    return await db.select().from(coachVenuePreferences);
  }

  async setCoachVenuePreferences(coachName: string, venueNames: string[], coachUserId?: string): Promise<void> {
    await db.transaction(async tx => {
      await lockScheduleWrites(tx);
      const coach = (await resolveCoach(tx, coachName, coachUserId))!;
      const where = eq(coachVenuePreferences.coachUserId, coach.id);
      const before = await tx.select().from(coachVenuePreferences).where(where);
      await tx.delete(coachVenuePreferences).where(where);
      if (venueNames.length) await tx.insert(coachVenuePreferences).values(venueNames.map(venueName => ({ coachUserId: coach.id, coachName: coach.name, venueName })));
      const after = await tx.select().from(coachVenuePreferences).where(where);
      await audit(tx, "coach_preferences", coach.id, before, after);
    });
  }

  /**
   * Returns availability-slot count and venue-preference count for one
   * coach. Used by both the admin fill-rate dashboard and the coach-portal
   * fill-status badge so the SQL lives in one place.
   */
  async getCoachFillStatus(
    coachName: string,
    coachUserId?: string
  ): Promise<{ availabilitySlots: number; venuePrefsCount: number }> {
    const [availRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(coachAvailability)
      .where(coachUserId ? eq(coachAvailability.coachUserId, coachUserId) : eq(coachAvailability.coachName, coachName));
    const [prefsRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(coachVenuePreferences)
      .where(coachUserId ? eq(coachVenuePreferences.coachUserId, coachUserId) : eq(coachVenuePreferences.coachName, coachName));
    return {
      availabilitySlots: availRow?.count ?? 0,
      venuePrefsCount: prefsRow?.count ?? 0,
    };
  }
}
