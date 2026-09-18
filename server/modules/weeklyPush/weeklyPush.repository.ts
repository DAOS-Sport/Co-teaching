/**
 * Repository for the weekly push pipeline (Task #23).
 *
 * All DB access for `weekly_push_runs` and `weekly_push_recipients`
 * lives here so the routes / service / worker layers stay free of
 * Drizzle calls. Per the architecture rules from Task #22, routes
 * never touch the DB directly.
 */
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  weeklyPushRuns,
  weeklyPushRecipients,
  weeklyPushOutbox,
  type WeeklyPushRun,
  type WeeklyPushRecipient,
  type InsertWeeklyPushRun,
  type InsertWeeklyPushRecipient,
} from "@shared/schema";
import type {
  WeeklyPushRunStatus,
  WeeklyPushRecipientStatus,
} from "./types";

export const weeklyPushRepo = {
  async createRunBundle(
    runInput: InsertWeeklyPushRun,
    recipientInputs: InsertWeeklyPushRecipient[],
    queueName: string,
  ): Promise<{ run: WeeklyPushRun; created: boolean; recipientsCreated: number }> {
    return db.transaction(async (tx) => {
      const [run] = await tx.insert(weeklyPushRuns).values(runInput).onConflictDoNothing().returning();
      if (!run) {
        const [existing] = await tx.select().from(weeklyPushRuns)
          .where(eq(weeklyPushRuns.idempotencyKey, runInput.idempotencyKey!)).limit(1);
        if (!existing) throw new Error("weekly run conflict without persisted winner");
        return { run: existing, created: false, recipientsCreated: 0 };
      }
      const recipients = recipientInputs.length
        ? await tx.insert(weeklyPushRecipients).values(recipientInputs).returning()
        : [];
      await tx.update(weeklyPushRuns).set({
        totalCount: recipients.length,
        skippedCount: run.dryRun ? recipients.length : 0,
        updatedAt: new Date(),
      }).where(eq(weeklyPushRuns.id, run.id));
      await tx.insert(weeklyPushOutbox).values({
        runId: run.id,
        queueName,
        payloadJson: { runId: run.id },
        status: "pending",
      });
      return {
        run: { ...run, totalCount: recipients.length, skippedCount: run.dryRun ? recipients.length : 0 },
        created: true,
        recipientsCreated: recipients.length,
      };
    });
  },

  async listPendingOutbox(limit = 50) {
    return db.select().from(weeklyPushOutbox)
      .where(inArray(weeklyPushOutbox.status, ["pending", "failed"]))
      .orderBy(weeklyPushOutbox.createdAt).limit(limit);
  },

  async markOutboxPublished(id: string) {
    await db.update(weeklyPushOutbox).set({
      status: "published", publishedAt: new Date(), updatedAt: new Date(), lastError: null,
    }).where(eq(weeklyPushOutbox.id, id));
  },

  async markOutboxFailed(id: string, attemptCount: number, lastError: string) {
    await db.update(weeklyPushOutbox).set({
      status: "failed", attemptCount, lastError,
      nextAttemptAt: new Date(Date.now() + Math.min(300, 2 ** attemptCount) * 1000),
      updatedAt: new Date(),
    }).where(eq(weeklyPushOutbox.id, id));
  },
  // ── runs ─────────────────────────────────────────────────────────
  async createRun(input: InsertWeeklyPushRun): Promise<WeeklyPushRun | null> {
    const [row] = await db
      .insert(weeklyPushRuns)
      .values(input)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  },

  async getRunByIdempotencyKey(key: string): Promise<WeeklyPushRun | null> {
    const [row] = await db
      .select()
      .from(weeklyPushRuns)
      .where(eq(weeklyPushRuns.idempotencyKey, key))
      .limit(1);
    return row ?? null;
  },

  async getRunById(id: string): Promise<WeeklyPushRun | null> {
    const [row] = await db
      .select()
      .from(weeklyPushRuns)
      .where(eq(weeklyPushRuns.id, id))
      .limit(1);
    return row ?? null;
  },

  /**
   * Idempotency lookup — returns the most recent run for the same
   * (pushType, weekStart, weekEnd) whose status is in-flight or
   * already-succeeded so the caller can short-circuit a duplicate
   * enqueue.
   *
   * Per task spec: only `queued|running|success` block a new run.
   * `partial_failed` and `failed` deliberately allow re-trigger so
   * admins can recover from a bad week without manual DB surgery.
   */
  async findActiveRunForWeek(
    pushType: string,
    weekStartDate: string,
    weekEndDate: string,
  ): Promise<WeeklyPushRun | null> {
    const rows = await db
      .select()
      .from(weeklyPushRuns)
      .where(
        and(
          eq(weeklyPushRuns.pushType, pushType),
          eq(weeklyPushRuns.weekStartDate, weekStartDate),
          eq(weeklyPushRuns.weekEndDate, weekEndDate),
          inArray(weeklyPushRuns.status, ["queued", "running", "success"]),
        ),
      )
      .orderBy(desc(weeklyPushRuns.createdAt))
      .limit(1);
    return rows[0] ?? null;
  },

  async listRuns(limit = 50): Promise<WeeklyPushRun[]> {
    return db
      .select()
      .from(weeklyPushRuns)
      .orderBy(desc(weeklyPushRuns.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  },

  async listRunsByStatuses(statuses: WeeklyPushRunStatus[]): Promise<WeeklyPushRun[]> {
    if (statuses.length === 0) return [];
    return db.select().from(weeklyPushRuns).where(inArray(weeklyPushRuns.status, statuses));
  },

  async updateRun(
    id: string,
    patch: Partial<{
      status: WeeklyPushRunStatus;
      startedAt: Date;
      completedAt: Date;
      totalCount: number;
      successCount: number;
      failureCount: number;
      skippedCount: number;
      reportPath: string | null;
      errorMessage: string | null;
      destination: string;
    }>,
  ): Promise<WeeklyPushRun | null> {
    const [row] = await db
      .update(weeklyPushRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(weeklyPushRuns.id, id))
      .returning();
    return row ?? null;
  },

  // ── recipients ───────────────────────────────────────────────────
  async createRecipientsBulk(
    recipients: InsertWeeklyPushRecipient[],
  ): Promise<WeeklyPushRecipient[]> {
    if (recipients.length === 0) return [];
    return db.insert(weeklyPushRecipients).values(recipients).returning();
  },

  async getRecipientById(id: string): Promise<WeeklyPushRecipient | null> {
    const [row] = await db
      .select()
      .from(weeklyPushRecipients)
      .where(eq(weeklyPushRecipients.id, id))
      .limit(1);
    return row ?? null;
  },

  async listRecipientsByRun(runId: string): Promise<WeeklyPushRecipient[]> {
    return db
      .select()
      .from(weeklyPushRecipients)
      .where(eq(weeklyPushRecipients.runId, runId));
  },

  async listRecipientsByRunAndStatus(
    runId: string,
    status: WeeklyPushRecipientStatus,
  ): Promise<WeeklyPushRecipient[]> {
    return db
      .select()
      .from(weeklyPushRecipients)
      .where(
        and(
          eq(weeklyPushRecipients.runId, runId),
          eq(weeklyPushRecipients.status, status),
        ),
      );
  },

  async listStuckSendingRecipients(runId: string, cutoff: Date): Promise<WeeklyPushRecipient[]> {
    return db.select().from(weeklyPushRecipients).where(and(
      eq(weeklyPushRecipients.runId, runId),
      eq(weeklyPushRecipients.status, "sending"),
      lt(weeklyPushRecipients.updatedAt, cutoff),
    ));
  },

  async updateRecipient(
    id: string,
    patch: Partial<{
      status: WeeklyPushRecipientStatus;
      attemptCount: number;
      sentAt: Date | null;
      errorCode: string | null;
      errorMessage: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      nextRetryAt: Date | null;
      lineResponseCode: number | null;
    }>,
  ): Promise<WeeklyPushRecipient | null> {
    const [row] = await db
      .update(weeklyPushRecipients)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(weeklyPushRecipients.id, id))
      .returning();
    return row ?? null;
  },

  async cancelUnsentRecipients(runId: string): Promise<number> {
    const rows = await db
      .update(weeklyPushRecipients)
      .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(weeklyPushRecipients.runId, runId),
        inArray(weeklyPushRecipients.status, ["pending", "retry_wait"]),
      ))
      .returning({ id: weeklyPushRecipients.id });
    return rows.length;
  },

  /**
   * Returns the count of recipients in each status bucket for a run.
   * Used by the orchestrator to detect "all recipients done" without
   * loading every row.
   */
  /**
   * Returns all runs older than `cutoff` that still have a `report_path`.
   * Used by the 90-day cleanup job to find stale Object Storage objects.
   */
  async listRunsWithExpiredReports(cutoff: Date): Promise<WeeklyPushRun[]> {
    return db
      .select()
      .from(weeklyPushRuns)
      .where(
        and(
          isNotNull(weeklyPushRuns.reportPath),
          lt(weeklyPushRuns.createdAt, sql`${cutoff.toISOString()}::timestamptz`),
        ),
      );
  },

  async countRecipientStatuses(runId: string): Promise<{
    pending: number;
    sending: number;
    retryWait: number;
    success: number;
    failed: number;
    skipped: number;
    total: number;
  }> {
    const rows = await db
      .select({
        status: weeklyPushRecipients.status,
      })
      .from(weeklyPushRecipients)
      .where(eq(weeklyPushRecipients.runId, runId));

    const acc = { pending: 0, sending: 0, retryWait: 0, success: 0, failed: 0, skipped: 0, total: rows.length };
    for (const r of rows) {
      const s = r.status as WeeklyPushRecipientStatus;
      if (s === "pending") acc.pending += 1;
      else if (s === "sending") acc.sending += 1;
      else if (s === "retry_wait") acc.retryWait += 1;
      else if (s === "success") acc.success += 1;
      else if (s === "failed") acc.failed += 1;
      else if (s === "skipped") acc.skipped += 1;
    }
    return acc;
  },
};

export type WeeklyPushRepo = typeof weeklyPushRepo;
