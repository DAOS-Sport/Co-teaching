/**
 * Schedule repository.
 *
 * Owns every direct DB call related to the `schedules`, `coach_registrations`
 * and derived statistics/conflict queries. The IStorage façade in
 * `server/storage.ts` delegates its schedule-shaped methods here.
 */
import { and, between, eq, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { db } from "../db";
import { addDays, format } from "date-fns";
import {
  schedules,
  venues,
  timeSlots,
  coachRegistrations,
  type Schedule,
  type Venue,
  type TimeSlot,
  type CoachRegistration,
  type InsertScheduleType,
  type InsertCoachRegistrationType,
} from "@shared/schema";

const normalizeString = (s: string): string =>
  s.replace(/\s+/g, "").replace(/[－—–~～]/g, "-").trim();

const splitByAnySeparator = (s: string): string[] =>
  normalizeString(s).split(/[-、，,/|]/).filter(Boolean);

const scheduleSelect = {
  id: schedules.id,
  date: schedules.date,
  venueId: schedules.venueId,
  timeSlotId: schedules.timeSlotId,
  className: schedules.className,
  coachName: schedules.coachName,
  coachName2: schedules.coachName2,
  coach1IsTeaching: schedules.coach1IsTeaching,
  coach2IsTeaching: schedules.coach2IsTeaching,
  coachCount: schedules.coachCount,
  isClassLocked: schedules.isClassLocked,
  notes: schedules.notes,
  createdAt: schedules.createdAt,
  updatedAt: schedules.updatedAt,
  venue: venues,
  timeSlot: timeSlots,
};

export type ScheduleUpdateFields = Partial<{
  className: string;
  coachName: string;
  coachName2: string | null;
  coachCount: number;
  coach1IsTeaching: boolean;
  coach2IsTeaching: boolean;
}>;

export class ScheduleRepository {
  async copyWeekIntoEmptyCells(input: {
    sourceStartDate: string;
    sourceEndDate: string;
    targetStartDate: string;
    venueId: string;
    commit: boolean;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.venueId}:${input.targetStartDate}`}))`);
      const source = await tx.select().from(schedules).where(and(
        eq(schedules.venueId, input.venueId),
        between(schedules.date, input.sourceStartDate, input.sourceEndDate),
        isNotNull(schedules.className),
      ));
      const targetEndDate = format(addDays(new Date(`${input.targetStartDate}T00:00:00`), 6), "yyyy-MM-dd");
      const target = await tx.select().from(schedules).where(and(
        eq(schedules.venueId, input.venueId),
        between(schedules.date, input.targetStartDate, targetEndDate),
      )).for("update");
      const sourceStart = new Date(`${input.sourceStartDate}T00:00:00`);
      const targetStart = new Date(`${input.targetStartDate}T00:00:00`);
      const targetCells = new Map<string, typeof target>();
      for (const row of target) {
        const key = `${row.date}:${row.timeSlotId}`;
        targetCells.set(key, [...(targetCells.get(key) ?? []), row]);
      }
      const planned: InsertScheduleType[] = [];
      let duplicateClassSkipped = 0;
      let occupiedCellSkipped = 0;
      for (const row of source) {
        const offset = Math.round((new Date(`${row.date}T00:00:00`).getTime() - sourceStart.getTime()) / 86_400_000);
        const date = format(addDays(targetStart, offset), "yyyy-MM-dd");
        const existing = targetCells.get(`${date}:${row.timeSlotId}`) ?? [];
        if (existing.length > 0) {
          const normalized = row.className!.replace(/\s+/g, "").toLocaleLowerCase();
          if (existing.some((item) => item.className?.replace(/\s+/g, "").toLocaleLowerCase() === normalized)) duplicateClassSkipped++;
          else occupiedCellSkipped++;
          continue;
        }
        planned.push({
          date,
          venueId: row.venueId,
          timeSlotId: row.timeSlotId,
          className: row.className,
          coachName: null,
          coachName2: null,
          coachCount: row.coachCount,
          coach1IsTeaching: true,
          coach2IsTeaching: false,
        });
      }
      if (input.commit && planned.length > 0) {
        await tx.insert(schedules).values(planned);
      }
      return {
        sourceCount: source.length,
        plannedCount: planned.length,
        duplicateClassSkipped,
        occupiedCellSkipped,
        targetEndDate,
        items: planned.map((row) => ({ date: row.date, timeSlotId: row.timeSlotId, className: row.className })),
        committed: input.commit,
      };
    });
  }

  async getSchedulesByDate(
    date: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]> {
    return await db
      .select(scheduleSelect)
      .from(schedules)
      .innerJoin(venues, eq(schedules.venueId, venues.id))
      .innerJoin(timeSlots, eq(schedules.timeSlotId, timeSlots.id))
      .where(eq(schedules.date, date));
  }

  async getSchedulesByDateRange(
    startDate: string,
    endDate: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]> {
    return await db
      .select(scheduleSelect)
      .from(schedules)
      .innerJoin(venues, eq(schedules.venueId, venues.id))
      .innerJoin(timeSlots, eq(schedules.timeSlotId, timeSlots.id))
      .where(between(schedules.date, startDate, endDate));
  }

  async getVacantSchedules(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]> {
    return await db
      .select(scheduleSelect)
      .from(schedules)
      .innerJoin(venues, eq(schedules.venueId, venues.id))
      .innerJoin(timeSlots, eq(schedules.timeSlotId, timeSlots.id))
      .where(
        and(
          eq(schedules.venueId, venueId),
          between(schedules.date, startDate, endDate),
          isNotNull(schedules.className),
          sql`trim(${schedules.className}) <> ''`,
          or(isNull(schedules.coachName), eq(schedules.coachName, ""))
        )
      )
      .orderBy(schedules.date, timeSlots.order);
  }

  async upsertSchedule(schedule: InsertScheduleType): Promise<Schedule> {
    const [result] = await db
      .insert(schedules)
      .values({ ...schedule, updatedAt: new Date() })
      .returning();
    return result;
  }

  async getScheduleById(id: string): Promise<Schedule | undefined> {
    const [result] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id));
    return result;
  }

  async updateSchedule(
    id: string,
    updateData: ScheduleUpdateFields
  ): Promise<Schedule> {
    const setData: Record<string, unknown> = { updatedAt: new Date() };
    if (updateData.className !== undefined) setData.className = updateData.className;
    if (updateData.coachName !== undefined) setData.coachName = updateData.coachName;
    if (updateData.coachName2 !== undefined) setData.coachName2 = updateData.coachName2;
    if (updateData.coachCount !== undefined) setData.coachCount = updateData.coachCount;
    if (updateData.coach1IsTeaching !== undefined)
      setData.coach1IsTeaching = updateData.coach1IsTeaching;
    if (updateData.coach2IsTeaching !== undefined)
      setData.coach2IsTeaching = updateData.coach2IsTeaching;
    const [result] = await db
      .update(schedules)
      .set(setData)
      .where(eq(schedules.id, id))
      .returning();
    return result;
  }

  async deleteSchedule(id: string): Promise<void> {
    await db.delete(schedules).where(eq(schedules.id, id));
  }

  async getCoachSchedules(
    coachName: string,
    startDate: string,
    endDate: string
  ): Promise<(Schedule & { venue: Venue; timeSlot: TimeSlot })[]> {
    const normalizedCoachName = normalizeString(coachName);
    return await db
      .select(scheduleSelect)
      .from(schedules)
      .innerJoin(venues, eq(schedules.venueId, venues.id))
      .innerJoin(timeSlots, eq(schedules.timeSlotId, timeSlots.id))
      .where(
        and(
          or(
            eq(schedules.coachName, coachName),
            like(schedules.coachName, `%-${coachName}`),
            like(schedules.coachName, `${coachName}-%`),
            like(schedules.coachName, `%-${coachName}-%`),
            sql`replace(replace(replace(${schedules.coachName}, '－', '-'), '—', '-'), ' ', '') ILIKE ${`%${normalizedCoachName}%`}`,
            eq(schedules.coachName2, coachName),
            sql`replace(replace(replace(${schedules.coachName2}, '－', '-'), '—', '-'), ' ', '') ILIKE ${`%${normalizedCoachName}%`}`
          ),
          between(schedules.date, startDate, endDate)
        )
      );
  }

  async getConflicts(
    date: string
  ): Promise<{ coachName: string; timeSlotId: string; venues: string[] }[]> {
    const daySchedules = await this.getSchedulesByDate(date);
    const conflicts: { coachName: string; timeSlotId: string; venues: string[] }[] = [];
    const coachTimeSlotMap = new Map<string, Map<string, string[]>>();

    daySchedules.forEach((schedule) => {
      const coaches: string[] = [];
      if (schedule.coachName) {
        if (schedule.coachName.includes("-")) {
          const parts = schedule.coachName.split("-");
          for (let i = 1; i < parts.length; i++) {
            const coach = parts[i].trim();
            if (coach && coach !== "缺") coaches.push(coach);
          }
        } else {
          coaches.push(schedule.coachName.trim());
        }
      }
      if (schedule.coachName2) coaches.push(schedule.coachName2.trim());
      if (coaches.length === 0) return;

      coaches.forEach((coachName) => {
        if (!coachTimeSlotMap.has(coachName)) {
          coachTimeSlotMap.set(coachName, new Map());
        }
        const timeSlotMap = coachTimeSlotMap.get(coachName)!;
        if (!timeSlotMap.has(schedule.timeSlotId)) {
          timeSlotMap.set(schedule.timeSlotId, []);
        }
        timeSlotMap.get(schedule.timeSlotId)!.push(schedule.venue.name);
      });
    });

    coachTimeSlotMap.forEach((timeSlotMap, coachName) => {
      timeSlotMap.forEach((venueNames, timeSlotId) => {
        if (venueNames.length > 1) {
          conflicts.push({ coachName, timeSlotId, venues: venueNames });
        }
      });
    });

    return conflicts;
  }

  async getCoachStatistics(
    startDate: string,
    endDate: string,
    coachName?: string
  ): Promise<{
    coachName: string;
    totalClasses: number;
    teachingClasses: number;
    assistClasses: number;
    venueBreakdown: { venueName: string; count: number; color: string }[];
  }[]> {
    const allSchedules = await db
      .select({
        coachName: schedules.coachName,
        coachName2: schedules.coachName2,
        coach1IsTeaching: schedules.coach1IsTeaching,
        coach2IsTeaching: schedules.coach2IsTeaching,
        coachCount: schedules.coachCount,
        className: schedules.className,
        venueName: venues.name,
        venueColor: venues.color,
      })
      .from(schedules)
      .innerJoin(venues, eq(schedules.venueId, venues.id))
      .where(
        and(
          between(schedules.date, startDate, endDate),
          isNotNull(schedules.className),
          sql`(${schedules.coachName} IS NOT NULL AND ${schedules.coachName} != '' OR ${schedules.coachName2} IS NOT NULL AND ${schedules.coachName2} != '')`
        )
      );

    const coachStats = new Map<
      string,
      {
        totalClasses: number;
        teachingClasses: number;
        assistClasses: number;
        venueMap: Map<string, { count: number; color: string }>;
      }
    >();

    const addCoachCount = (
      name: string,
      venueName: string,
      venueColor: string,
      isTeaching: boolean
    ) => {
      if (!name || name.trim() === "") return;
      const trimmed = name.trim();
      if (!coachStats.has(trimmed)) {
        coachStats.set(trimmed, {
          totalClasses: 0,
          teachingClasses: 0,
          assistClasses: 0,
          venueMap: new Map(),
        });
      }
      const stats = coachStats.get(trimmed)!;
      stats.totalClasses += 1;
      if (isTeaching) stats.teachingClasses += 1;
      else stats.assistClasses += 1;
      const existing = stats.venueMap.get(venueName);
      if (existing) {
        existing.count += 1;
      } else {
        stats.venueMap.set(venueName, { count: 1, color: venueColor });
      }
    };

    for (const row of allSchedules) {
      if (row.coachName)
        addCoachCount(row.coachName, row.venueName, row.venueColor, !!row.coach1IsTeaching);
      if (row.coachCount >= 2 && row.coachName2 && (!row.coachName || normalizeString(row.coachName) !== normalizeString(row.coachName2)))
        addCoachCount(row.coachName2, row.venueName, row.venueColor, !!row.coach2IsTeaching);
    }

    let result = Array.from(coachStats.entries()).map(([name, stats]) => ({
      coachName: name,
      totalClasses: stats.totalClasses,
      teachingClasses: stats.teachingClasses,
      assistClasses: stats.assistClasses,
      venueBreakdown: Array.from(stats.venueMap.entries()).map(([venueName, v]) => ({
        venueName,
        count: v.count,
        color: v.color,
      })),
    }));

    if (coachName) result = result.filter((r) => r.coachName.includes(coachName));
    result.sort((a, b) => b.totalClasses - a.totalClasses);
    return result;
  }

  async getUniqueCoaches(): Promise<string[]> {
    const results = await db
      .selectDistinct({ coachName: schedules.coachName })
      .from(schedules)
      .where(
        sql`${schedules.coachName} IS NOT NULL AND ${schedules.coachName} != '' AND ${schedules.coachName} NOT LIKE '%缺%'`
      );

    const uniqueCoaches = new Set<string>();
    results.forEach((result) => {
      if (!result.coachName) return;
      if (/[-－—–~～、，,/|]/.test(result.coachName)) {
        const parts = splitByAnySeparator(result.coachName);
        for (let i = 1; i < parts.length; i++) {
          const coach = parts[i].trim();
          if (coach && coach !== "缺") uniqueCoaches.add(coach);
        }
      } else {
        const coach = result.coachName.trim();
        if (coach && coach !== "缺") uniqueCoaches.add(coach);
      }
    });
    return Array.from(uniqueCoaches).sort();
  }

  private async fetchSchedulesNeedingCoach(
    extraWhere?: ReturnType<typeof between>
  ): Promise<
    (Schedule & { venue: Venue; timeSlot: TimeSlot; registrations: CoachRegistration[] })[]
  > {
    const baseConditions = [
      sql`${schedules.className} IS NOT NULL AND ${schedules.className} != ''`,
      or(
        sql`${schedules.coachName} IS NULL`,
        sql`${schedules.coachName} = ''`,
        sql`${schedules.coachName} LIKE '%缺%'`
      ),
    ];
    if (extraWhere) baseConditions.push(extraWhere);

    const results = await db
      .select({
        ...scheduleSelect,
        registrationId: coachRegistrations.id,
        registrationCoachName: coachRegistrations.coachName,
        registrationRegisteredAt: coachRegistrations.registeredAt,
      })
      .from(schedules)
      .innerJoin(venues, eq(schedules.venueId, venues.id))
      .innerJoin(timeSlots, eq(schedules.timeSlotId, timeSlots.id))
      .leftJoin(coachRegistrations, eq(schedules.id, coachRegistrations.scheduleId))
      .where(and(...baseConditions))
      .orderBy(schedules.date, timeSlots.order);

    const schedulesMap = new Map<
      string,
      Schedule & { venue: Venue; timeSlot: TimeSlot; registrations: CoachRegistration[] }
    >();

    for (const result of results) {
      const scheduleId = result.id;
      if (!schedulesMap.has(scheduleId)) {
        schedulesMap.set(scheduleId, {
          id: result.id,
          date: result.date,
          venueId: result.venueId,
          timeSlotId: result.timeSlotId,
          className: result.className,
          coachName: result.coachName,
          coachName2: result.coachName2,
          coach1IsTeaching: result.coach1IsTeaching,
          coach2IsTeaching: result.coach2IsTeaching,
          coachCount: result.coachCount,
          isClassLocked: result.isClassLocked,
          notes: result.notes,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
          venue: result.venue,
          timeSlot: result.timeSlot,
          registrations: [],
        });
      }
      if (result.registrationId) {
        const schedule = schedulesMap.get(scheduleId)!;
        schedule.registrations.push({
          id: result.registrationId,
          scheduleId,
          coachName: result.registrationCoachName!,
          registeredAt: result.registrationRegisteredAt!,
        });
      }
    }

    return Array.from(schedulesMap.values());
  }

  async getSchedulesWithoutCoach() {
    return this.fetchSchedulesNeedingCoach();
  }

  async getSchedulesWithoutCoachByDateRange(startDate: string, endDate: string) {
    return this.fetchSchedulesNeedingCoach(between(schedules.date, startDate, endDate));
  }

  async registerCoachForSchedule(
    registration: InsertCoachRegistrationType
  ): Promise<CoachRegistration> {
    const [result] = await db
      .insert(coachRegistrations)
      .values(registration)
      .returning();
    return result;
  }

  async getCoachRegistrations(scheduleId: string): Promise<CoachRegistration[]> {
    return await db
      .select()
      .from(coachRegistrations)
      .where(eq(coachRegistrations.scheduleId, scheduleId))
      .orderBy(coachRegistrations.registeredAt);
  }

  async lockSchedules(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<void> {
    await db
      .update(schedules)
      .set({ isClassLocked: true, updatedAt: new Date() })
      .where(
        and(
          eq(schedules.venueId, venueId),
          between(schedules.date, startDate, endDate)
        )
      );
  }

  async unlockSchedules(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<void> {
    await db
      .update(schedules)
      .set({ isClassLocked: false, updatedAt: new Date() })
      .where(
        and(
          eq(schedules.venueId, venueId),
          between(schedules.date, startDate, endDate)
        )
      );
  }

  async assignCoach(
    scheduleId: string,
    coachName: string | null
  ): Promise<Schedule> {
    const [result] = await db
      .update(schedules)
      .set({ coachName, updatedAt: new Date() })
      .where(eq(schedules.id, scheduleId))
      .returning();
    return result;
  }

  async getScheduleLockStatus(
    venueId: string,
    startDate: string,
    endDate: string
  ): Promise<boolean> {
    const result = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.venueId, venueId),
          between(schedules.date, startDate, endDate)
        )
      );
    if (result.length === 0) return false;
    return result.every((s) => s.isClassLocked);
  }
}
