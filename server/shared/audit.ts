import type { Request } from "express";
import { operationAudit } from "@shared/schema";
import type { AuditAction, AuditEntity } from "@shared/auditActions";
import { currentDb, isInTransaction } from "./dbContext";
import { recordAppLog } from "./appLog";
import { storage } from "../storage";

/** Who did it (10/14: one shared admin login, no personal accounts). */
export const ADMIN_ACTOR = "共用管理員";
export const MCP_ACTOR = "MCP";
export const coachActor = (name: string) => `教練：${name}`;

export interface AuditEntry {
  actor: string;
  requestId?: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Human-readable context shown under the entry (which class, which week). */
  reason?: string | null;
}

type AuditWriter = (entry: AuditEntry) => Promise<void>;

const dbWriter: AuditWriter = async (entry) => {
  await currentDb().insert(operationAudit).values({
    actor: entry.actor,
    requestId: entry.requestId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    beforeData: entry.before ?? null,
    afterData: entry.after ?? null,
    reason: entry.reason ?? null,
  });
};

let writer: AuditWriter = dbWriter;

export function setAuditWriterForTest(next: AuditWriter | null): void {
  writer = next ?? dbWriter;
}

export function requestIdOf(req: Request): string | null {
  const value = req.res?.getHeader("X-Request-ID");
  return typeof value === "string" ? value : null;
}

/**
 * Audit row for a database change. Must run inside inTransaction() together
 * with the change, so a failed audit write rolls the change back.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  if (!isInTransaction()) throw new Error(`recordAudit(${entry.action}) must run inside inTransaction()`);
  await writer(entry);
}

/**
 * Audit row for an action with outside effects (LINE push, Ragic, queued
 * jobs) that cannot be rolled back: written after the outcome is known and
 * never fails the request; a failed write lands in the error log instead.
 */
export async function recordTriggerAudit(entry: AuditEntry): Promise<void> {
  try {
    await writer(entry);
  } catch {
    recordAppLog({ level: "error", source: "system", code: "AUDIT_WRITE_FAILED", message: entry.action, requestId: entry.requestId ?? null });
  }
}

// ── Context lines. Read before the transaction; a failed lookup only
//    shortens the line and never aborts the write. ──

export async function venueNameOf(venueId: string): Promise<string> {
  try {
    return (await storage.getVenues()).find((v) => v.id === venueId)?.name ?? venueId;
  } catch {
    return venueId;
  }
}

/** e.g. "新北高中 2026-10-19 第3節 A班" */
export async function scheduleContext(row: { venueId: string; date: string; timeSlotId: string; className: string | null }): Promise<string> {
  try {
    const [venues, slots] = await Promise.all([storage.getVenues(), storage.getTimeSlots()]);
    const order = slots.find((s) => s.id === row.timeSlotId)?.order;
    return [venues.find((v) => v.id === row.venueId)?.name, row.date, order ? `第${order}節` : null, row.className]
      .filter(Boolean)
      .join(" ");
  } catch {
    return [row.date, row.className].filter(Boolean).join(" ");
  }
}

// ── Snapshots: only the fields worth showing, never contact details. ──

type ScheduleLike = {
  date: string;
  className: string | null;
  coachName: string | null;
  coachName2: string | null;
  coachCount: number;
  coach1IsTeaching: boolean | null;
  coach2IsTeaching: boolean | null;
  isClassLocked?: boolean | null;
  notes?: string | null;
};

export function scheduleFields(row: ScheduleLike | null | undefined) {
  if (!row) return null;
  return {
    date: row.date,
    className: row.className,
    coachName: row.coachName,
    coachName2: row.coachName2,
    coachCount: row.coachCount,
    coach1IsTeaching: !!row.coach1IsTeaching,
    coach2IsTeaching: !!row.coach2IsTeaching,
    isClassLocked: !!row.isClassLocked,
    notes: row.notes ?? null,
  };
}

/** Phone, email and LINE ID are reduced to whether they are set (#3 spec S4b). */
export function coachFields(user: {
  name: string;
  status?: string | null;
  linkedCoachName?: string | null;
  lineId?: string | null;
  phone?: string | null;
  email?: string | null;
} | null | undefined) {
  if (!user) return null;
  return {
    name: user.name,
    status: user.status ?? null,
    linkedCoachName: user.linkedCoachName ?? null,
    lineId: user.lineId ? "已綁定" : "未綁定",
    phone: user.phone ? "已填" : "未填",
    email: user.email ? "已填" : "未填",
  };
}
