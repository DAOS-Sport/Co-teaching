import { between, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { coachUsers, schedules, timeSlots, venues } from "@shared/schema";
import {
  parseScheduleImportText,
  type ScheduleImportInputRow,
  type ScheduleImportMode,
  type ScheduleImportParseError,
} from "@shared/scheduleImport";

export type ScheduleImportIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type ScheduleImportPreviewRow = ScheduleImportInputRow & {
  timeSlotId: string | null;
  status: "create" | "update" | "skip" | "error";
  existingScheduleId: string | null;
  issues: ScheduleImportIssue[];
};

export type ScheduleImportPreview = {
  venue: { id: string; name: string } | null;
  mode: ScheduleImportMode;
  rows: ScheduleImportPreviewRow[];
  parseErrors: ScheduleImportParseError[];
  summary: { total: number; create: number; update: number; skip: number; error: number; warning: number };
  canCommit: boolean;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DbTransaction;

const rowKey = (row: Pick<ScheduleImportInputRow, "date" | "period" | "className">) =>
  `${row.date}|${row.period}|${row.className.trim()}`;
const coachSlotKey = (date: string, timeSlotId: string, coach: string) =>
  `${date}|${timeSlotId}|${coach.trim()}`;

async function buildPreview(
  executor: Executor,
  venueId: string,
  text: string,
  mode: ScheduleImportMode,
): Promise<ScheduleImportPreview> {
  const parsed = parseScheduleImportText(text);
  const [venue] = await executor
    .select({ id: venues.id, name: venues.name })
    .from(venues)
    .where(eq(venues.id, venueId));

  if (!venue) {
    parsed.errors.push({ line: 1, message: "選擇的場館不存在" });
  }
  if (parsed.rows.length === 0 || !venue) {
    return {
      venue: venue ?? null,
      mode,
      rows: [],
      parseErrors: parsed.errors,
      summary: { total: 0, create: 0, update: 0, skip: 0, error: parsed.errors.length, warning: 0 },
      canCommit: false,
    };
  }

  const dates = parsed.rows.map((row) => row.date).sort();
  const [slotRows, existing, approvedCoaches] = await Promise.all([
    executor.select().from(timeSlots),
    executor
      .select()
      .from(schedules)
      .where(between(schedules.date, dates[0], dates[dates.length - 1])),
    executor
      .select({ name: coachUsers.name, linkedCoachName: coachUsers.linkedCoachName })
      .from(coachUsers)
      .where(eq(coachUsers.status, "approved")),
  ]);
  const slotByOrder = new Map(slotRows.map((slot) => [slot.order, slot]));
  const knownCoaches = new Set(
    approvedCoaches.flatMap((coach) => [coach.name, coach.linkedCoachName].filter(Boolean) as string[]),
  );
  const duplicateKeys = new Set<string>();
  const importedCoachSlots = new Set<string>();

  const rows: ScheduleImportPreviewRow[] = parsed.rows.map((row) => {
    const issues: ScheduleImportIssue[] = [];
    const slot = slotByOrder.get(row.period);
    const key = rowKey(row);
    if (duplicateKeys.has(key)) {
      issues.push({ severity: "error", code: "duplicate_input", message: "同一份匯入資料中有重複課程" });
    }
    duplicateKeys.add(key);
    if (!slot) {
      issues.push({ severity: "error", code: "unknown_period", message: `系統找不到第 ${row.period} 節` });
    }

    const matching = existing.find(
      (item) =>
        item.venueId === venueId &&
        item.date === row.date &&
        item.timeSlotId === slot?.id &&
        item.className?.trim() === row.className.trim(),
    );
    const lockedOnDate = existing.some(
      (item) => item.venueId === venueId && item.date === row.date && item.isClassLocked,
    );
    if (lockedOnDate || matching?.isClassLocked) {
      issues.push({ severity: "error", code: "locked", message: "該日期的場館課表已鎖定" });
    }

    for (const coach of [row.coachName, row.coachName2].filter(Boolean) as string[]) {
      if (!knownCoaches.has(coach)) {
        issues.push({ severity: "warning", code: "unknown_coach", message: `教練「${coach}」不在已核准名單` });
      }
      if (!slot) continue;
      const conflict = existing.some(
        (item) =>
          item.id !== matching?.id &&
          item.date === row.date &&
          item.timeSlotId === slot.id &&
          (item.coachName === coach || item.coachName2 === coach),
      );
      const importedKey = coachSlotKey(row.date, slot.id, coach);
      if (conflict || importedCoachSlots.has(importedKey)) {
        issues.push({ severity: "warning", code: "coach_conflict", message: `教練「${coach}」在同一節已有其他課程` });
      }
      importedCoachSlots.add(importedKey);
    }

    const hasError = issues.some((issue) => issue.severity === "error");
    let status: ScheduleImportPreviewRow["status"] = "create";
    if (hasError) status = "error";
    else if (matching && mode === "update_matching") status = "update";
    else if (matching) status = "skip";

    return {
      ...row,
      timeSlotId: slot?.id ?? null,
      status,
      existingScheduleId: matching?.id ?? null,
      issues,
    };
  });

  const summary = {
    total: rows.length,
    create: rows.filter((row) => row.status === "create").length,
    update: rows.filter((row) => row.status === "update").length,
    skip: rows.filter((row) => row.status === "skip").length,
    error: rows.filter((row) => row.status === "error").length + parsed.errors.length,
    warning: rows.reduce((count, row) => count + row.issues.filter((issue) => issue.severity === "warning").length, 0),
  };
  return {
    venue,
    mode,
    rows,
    parseErrors: parsed.errors,
    summary,
    canCommit: summary.error === 0 && (summary.create > 0 || summary.update > 0),
  };
}

export function previewScheduleImport(venueId: string, text: string, mode: ScheduleImportMode) {
  return buildPreview(db, venueId, text, mode);
}

export async function commitScheduleImport(venueId: string, text: string, mode: ScheduleImportMode) {
  return db.transaction(async (tx) => {
    // Serialize imports for the same venue. The lock is held only for this
    // transaction and ensures the re-preview sees any earlier import commit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${venueId}))`);
    const preview = await buildPreview(tx, venueId, text, mode);
    if (!preview.canCommit) {
      return { committed: false as const, preview };
    }
    const actionable = preview.rows.filter((row) => row.status === "create" || row.status === "update");
    const now = new Date();
    for (const row of actionable) {
      const values = {
        date: row.date,
        venueId,
        timeSlotId: row.timeSlotId!,
        className: row.className.trim(),
        coachName: row.coachName,
        coachName2: row.coachName2,
        coachCount: row.coachCount,
        notes: row.notes,
        updatedAt: now,
      };
      if (row.status === "update" && row.existingScheduleId) {
        await tx.update(schedules).set(values).where(eq(schedules.id, row.existingScheduleId));
      } else {
        await tx.insert(schedules).values(values);
      }
    }
    return {
      committed: true as const,
      created: preview.summary.create,
      updated: preview.summary.update,
      skipped: preview.summary.skip,
      warningCount: preview.summary.warning,
      preview,
    };
  });
}
