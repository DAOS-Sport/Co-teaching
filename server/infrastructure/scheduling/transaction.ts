import { sql } from "drizzle-orm";
import { currentDb, inTransaction, isInTransaction } from "../../shared/dbContext";
import type { ScheduleLocks } from "../../core/scheduling/ports";

const postgresLocks: ScheduleLocks = {
  async acquire(keys) {
    if (!isInTransaction()) throw new Error("SCHEDULE_LOCK_REQUIRES_TRANSACTION");
    for (const key of keys) await currentDb().execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  },
};
let testLocks: ScheduleLocks | null = null;
export function setSchedulingLocksForTest(locks: ScheduleLocks | null): void { testLocks = locks; }
export const schedulingLocks = (): ScheduleLocks => testLocks ?? postgresLocks;

/** One ordering boundary for single-row and batch scheduling mutations. */
export function inScheduleTransaction<T>(work: () => Promise<T>): Promise<T> {
  return inTransaction(async () => {
    await schedulingLocks().acquire(["schedule-writes"]);
    return work();
  });
}
