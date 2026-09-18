import { and, eq, sql } from "drizzle-orm";
import { schedules, coachUsers, coachAvailability, timeSlots, type InsertSchedule, type Schedule } from "@shared/schema";
import { audit, MutationError, type Transaction } from "./audit";
import { actorContext } from "./auth/auditContext";

// All schedule and availability writers take the same transaction lock. This also
// serializes writes to different venues, which row locks alone cannot protect.
export const lockScheduleWrites = (tx: Transaction) => tx.execute(sql`SELECT pg_advisory_xact_lock(620260918)`);
export async function resolveCoach(tx: Transaction, name: string | null | undefined, id?: string | null) {
  if (!name && !id) return null;
  const rows = await tx.select().from(coachUsers).where(id ? eq(coachUsers.id, id) : eq(coachUsers.name, name!.trim()));
  if (rows.length !== 1 || rows[0].status !== "approved") throw new MutationError("COACH_IDENTITY_AMBIGUOUS");
  return rows[0];
}
const minutes = (time: string) => {
  const parts = time.split(":").map(Number); return parts[0] * 60 + (parts[1] ?? 0);
};

export async function writeSchedule(tx: Transaction, id: string | null, input: Partial<InsertSchedule>, expectedVersion?: number): Promise<Schedule> {
  await lockScheduleWrites(tx);
  const [before] = id ? await tx.select().from(schedules).where(eq(schedules.id, id)).for("update") : [];
  if (id && !before) throw new MutationError("SCHEDULE_NOT_FOUND", 404);
  if (before && (!Number.isInteger(expectedVersion) || expectedVersion! < 1)) throw new MutationError("VERSION_REQUIRED", 428);
  if (before && before.version !== expectedVersion) throw new MutationError("VERSION_CONFLICT");
  const override = actorContext.getStore()?.role === "admin" && !!actorContext.getStore()?.overrideReason;
  if (before?.isClassLocked && !override) throw new MutationError("SCHEDULE_LOCKED");
  const next = { ...before, ...input };
  const coaches = [
    await resolveCoach(tx, next.coachName, input.coachName !== undefined && input.coachName !== before?.coachName ? input.coachUserId : next.coachUserId),
    await resolveCoach(tx, next.coachName2, input.coachName2 !== undefined && input.coachName2 !== before?.coachName2 ? input.coachUserId2 : next.coachUserId2),
  ];
  if (coaches[0] && coaches[0].id === coaches[1]?.id) throw new MutationError("DUPLICATE_COACH");
  if ((next.coachCount ?? 1) < coaches.filter(Boolean).length) throw new MutationError("COACH_COUNT_EXCEEDED");
  const [slot] = await tx.select().from(timeSlots).where(eq(timeSlots.id, next.timeSlotId!));
  if (!slot || !next.date || !/^\d{4}-\d{2}-\d{2}$/.test(next.date)) throw new MutationError("INVALID_SCHEDULE", 400);
  const day = new Date(next.date + "T00:00:00Z");
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() - weekday + 1);
  const weekStart = day.toISOString().slice(0, 10);
  const others = await tx.select({ schedule: schedules, slot: timeSlots }).from(schedules)
    .innerJoin(timeSlots, eq(timeSlots.id, schedules.timeSlotId)).where(eq(schedules.date, next.date));
  if (!override) for (const coach of coaches) {
    if (!coach) continue;
    const [available] = await tx.select().from(coachAvailability).where(and(
      eq(coachAvailability.coachUserId, coach.id), eq(coachAvailability.weekStart, weekStart),
      eq(coachAvailability.dayOfWeek, weekday), eq(coachAvailability.timeSlotOrder, slot.order),
    ));
    if (!available) throw new MutationError("COACH_UNAVAILABLE");
    if (others.some(({ schedule: other, slot: otherSlot }) => other.id !== id &&
        (other.coachUserId === coach.id || other.coachUserId2 === coach.id ||
          (!other.coachUserId && other.coachName === coach.name) || (!other.coachUserId2 && other.coachName2 === coach.name)) &&
        minutes(slot.startTime) < minutes(otherSlot.endTime) && minutes(otherSlot.startTime) < minutes(slot.endTime))) {
      throw new MutationError("COACH_TIME_CONFLICT");
    }
  }
  const values = { ...input, coachUserId: coaches[0]?.id ?? null, coachUserId2: coaches[1]?.id ?? null,
    coachName: coaches[0]?.name ?? null, coachName2: coaches[1]?.name ?? null,
    updatedAt: new Date(), version: (before?.version ?? 0) + 1 };
  const [after] = id ? await tx.update(schedules).set(values).where(and(eq(schedules.id, id), eq(schedules.version, expectedVersion!))).returning()
    : await tx.insert(schedules).values(values as InsertSchedule).returning();
  if (!after) throw new MutationError("VERSION_CONFLICT");
  await audit(tx, "schedule", after.id, before, after);
  return after;
}

export async function removeSchedule(tx: Transaction, id: string, expectedVersion: number) {
  await lockScheduleWrites(tx);
  const [before] = await tx.select().from(schedules).where(eq(schedules.id, id)).for("update");
  if (!before) throw new MutationError("SCHEDULE_NOT_FOUND", 404);
  if (!Number.isInteger(expectedVersion)) throw new MutationError("VERSION_REQUIRED", 428);
  if (before.version !== expectedVersion) throw new MutationError("VERSION_CONFLICT");
  if (before.isClassLocked && !(actorContext.getStore()?.role === "admin" && actorContext.getStore()?.overrideReason)) throw new MutationError("SCHEDULE_LOCKED");
  await tx.delete(schedules).where(eq(schedules.id, id));
  await audit(tx, "schedule", id, before, null);
}
