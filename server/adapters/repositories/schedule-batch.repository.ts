import { and, between, eq, getTableColumns, inArray, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { coachAvailability, coachUsers, schedules, timeSlots, venues } from "@shared/schema";
import type { ScheduleImportMode } from "@shared/scheduleImport";
import { parseScheduleImportText } from "@shared/scheduleImport";
import { txDb as db } from "../../shared/dbContext";
import { env } from "../../config/env";
import { createBatchConfirmation } from "../services/batch-confirmation";
import { inScheduleTransaction } from "../../infrastructure/scheduling/transaction";
import { addUtcDays, planCopyWeek, planImport, validateCopyInput, type CopyInput, type ImportContext, type ImportRow, type KeyedSchedule } from "../../core/scheduling/batch-plan";
import { mondayOf } from "../../core/scheduling/policies";

// Reuse the declared index expression, including its actual PostgreSQL regex and
// collation semantics. Do not approximate SQL identity with a JavaScript regex.
const classExpression = getTableConfig(schedules).indexes.find(i => i.config.name === "uniq_schedule_class_in_cell")?.config.columns[3] as SQL;
if (!classExpression) throw new Error("SCHEDULE_CLASS_IDENTITY_MISSING");
const selected = { ...getTableColumns(schedules), classKey: sql<string>`coalesce(${classExpression}, '')` };
const codec = () => createBatchConfirmation(env.adminPassword);
export type BatchImportOptions = { providedFieldsByLine?: Record<number, ImportRow["providedFields"]> };
let testClassIdentity: ((names: string[]) => Promise<Map<string, string>>) | null = null;
/** Explicit fixture seam; real SQL/index identity is exercised on PostgreSQL. */
export function setClassIdentityForTest(next: typeof testClassIdentity): void { testClassIdentity = next; }
const stable = (context: ImportContext): ImportContext => ({ ...context,
  schedules: context.schedules.slice().sort((a, b) => a.id.localeCompare(b.id)),
  slots: context.slots.slice().sort((a, b) => a.id.localeCompare(b.id)),
  approvedCoaches: context.approvedCoaches.slice().sort(),
  availability: context.availability.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});

async function importSnapshot(venueId: string, text: string, mode: ScheduleImportMode, options: BatchImportOptions) {
  const parsed = parseScheduleImportText(text), dates = Array.from(new Set(parsed.rows.map(r => r.date)));
  const weeks = Array.from(new Set(dates.map(mondayOf)));
  const venueRows = await db.select({ id: venues.id, name: venues.name }).from(venues).where(eq(venues.id, venueId));
    const slots = await db.select({ id: timeSlots.id, order: timeSlots.order }).from(timeSlots);
    const existing = await db.select(selected).from(schedules).where(inArray(schedules.date, dates));
    const approved = await db.select({ name: coachUsers.name, linkedCoachName: coachUsers.linkedCoachName }).from(coachUsers).where(eq(coachUsers.status, "approved"));
    const availability = await db.select({ coachName: coachAvailability.coachName, weekStart: coachAvailability.weekStart,
      dayOfWeek: coachAvailability.dayOfWeek, timeSlotOrder: coachAvailability.timeSlotOrder }).from(coachAvailability).where(inArray(coachAvailability.weekStart, weeks));
  const names = Array.from(new Set(parsed.rows.map(r => r.className)));
  const keys = testClassIdentity ? [] : names.length ? (await db.execute(sql`select class_name as original, ${classExpression} as key from (select unnest(${sql.param(names)}::text[]) as class_name) as schedules`)).rows as { original: string; key: string }[] : [];
  const keyByName = testClassIdentity ? await testClassIdentity(names) : new Map(keys.map(k => [k.original, k.key]));
  const rows: ImportRow[] = parsed.rows.map(r => ({ ...r, classKey: keyByName.get(r.className)!,
    providedFields: options.providedFieldsByLine?.[r.line] ?? parsed.providedFields }));
  const context = stable({ venue: venueRows[0] ?? null, schedules: existing as KeyedSchedule[], slots,
    approvedCoaches: approved.flatMap(c => [c.name, c.linkedCoachName].filter((v): v is string => !!v)), availability });
  const preview = planImport({ rows, errors: parsed.errors, mode, context });
  const signed = { kind: "import", input: { venueId, text, mode, options }, context };
  return { preview: { ...preview, confirmationToken: codec().issue(signed) }, signed };
}

export function previewBatchImport(venueId: string, text: string, mode: ScheduleImportMode, options: BatchImportOptions = {}) {
  return inScheduleTransaction(async () => (await importSnapshot(venueId, text, mode, options)).preview);
}
export function commitBatchImport(venueId: string, text: string, mode: ScheduleImportMode, confirmationToken?: unknown, options: BatchImportOptions = {}) {
  return inScheduleTransaction(async () => {
    const { preview, signed } = await importSnapshot(venueId, text, mode, options);
    if (!codec().verify(confirmationToken, signed) || !preview.canCommit) return {
      committed: false as const, code: confirmationToken ? "PREVIEW_CHANGED" : "PREVIEW_REQUIRED", preview,
    };
    const creates = [];
    for (const row of preview.rows) {
      if (row.status === "create") creates.push(row.values as typeof schedules.$inferInsert);
      if (row.status === "update" && row.existingScheduleId) {
        const old = signed.context.schedules.find(s => s.id === row.existingScheduleId)!;
        const changed = await db.update(schedules).set({ ...row.values, version: sql`${schedules.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schedules.id, old.id), eq(schedules.version, old.version))).returning({ id: schedules.id });
        if (changed.length !== 1) throw Object.assign(new Error("PREVIEW_CHANGED"), { code: "PREVIEW_CHANGED" });
      }
    }
    if (creates.length) await db.insert(schedules).values(creates);
    return { committed: true as const, created: preview.summary.create, updated: preview.summary.update,
      skipped: preview.summary.skip, warningCount: preview.summary.warning, preview };
  });
}

export function copyBatchWeek(input: CopyInput & { commit: boolean; confirmationToken?: unknown }) {
  validateCopyInput(input);
  return inScheduleTransaction(async () => {
    const rows = await db.select(selected).from(schedules).where(and(eq(schedules.venueId, input.venueId),
      or(between(schedules.date, input.sourceStartDate, input.sourceEndDate), between(schedules.date, input.targetStartDate, addUtcDays(input.targetStartDate, 6)))));
    const preview = planCopyWeek(input, rows as KeyedSchedule[]);
    const params = { sourceStartDate: input.sourceStartDate, sourceEndDate: input.sourceEndDate, targetStartDate: input.targetStartDate, venueId: input.venueId };
    const signed = { kind: "copy", input: params, rows: rows.slice().sort((a, b) => a.id.localeCompare(b.id)) };
    const confirmationToken = codec().issue(signed);
    if (!input.commit) return { ...preview, confirmationToken, committed: false, code: undefined };
    if (!codec().verify(input.confirmationToken, signed) || !preview.canCommit) return {
      ...preview, confirmationToken, committed: false, code: input.confirmationToken ? "PREVIEW_CHANGED" : "PREVIEW_REQUIRED",
    };
    await db.insert(schedules).values(preview.rows.map(r => r.values as typeof schedules.$inferInsert));
    return { ...preview, confirmationToken, committed: true, code: undefined };
  });
}
