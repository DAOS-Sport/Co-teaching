import type { SchedulePatch, ScheduleRow } from "./entities";
import { assignmentWarnings, mondayOf, newlyPlacedCoaches, normalizeScheduleName, preparePatch, sameCoach } from "./policies";

export type ImportField = "date" | "period" | "className" | "coachName" | "coachName2" | "coachCount" | "notes";
export interface ImportRow {
  line: number; date: string; period: number; className: string; classKey: string;
  coachName: string | null; coachName2: string | null; coachCount: 1 | 2; notes: string | null;
  providedFields?: ImportField[];
}
export type KeyedSchedule = ScheduleRow & { classKey: string; venue?: { name: string } };
export type PlanIssue = { severity: "error" | "warning"; code: string; message: string };
export type PlanRow = ImportRow & {
  timeSlotId: string | null; status: "create" | "update" | "skip" | "error";
  existingScheduleId: string | null; issues: PlanIssue[]; values: SchedulePatch;
  clearedFields: string[]; changes: { field: string; before: unknown; after: unknown }[];
};
export interface ImportContext {
  venue: { id: string; name: string } | null; schedules: KeyedSchedule[];
  slots: { id: string; order: number }[]; approvedCoaches: string[];
  availability: { coachName: string; weekStart: string; dayOfWeek: number; timeSlotOrder: number }[];
}

/** classKey is supplied by the repository using the actual unique-index SQL expression. */
export function planImport(input: { rows: ImportRow[]; errors: { line: number; message: string }[]; mode: "insert_only" | "update_matching"; context: ImportContext }) {
  const { context, mode } = input;
  const parseErrors = input.errors.slice();
  if (!context.venue) parseErrors.push({ line: 1, message: "選擇的場館不存在" });
  const seen = new Set<string>();
  const staged = context.schedules.slice();
  const approved = new Set(context.approvedCoaches.map(normalizeScheduleName));
  const rows: PlanRow[] = input.rows.map(row => {
    const slot = context.slots.find(s => s.order === row.period);
    const matching = context.schedules.find(s => s.venueId === context.venue?.id && s.date === row.date && s.timeSlotId === slot?.id && s.classKey === row.classKey);
    const key = JSON.stringify([row.date, row.period, row.classKey]);
    const issues: PlanIssue[] = [];
    if (seen.has(key)) issues.push({ severity: "error", code: "duplicate_input", message: "同一份資料有重複課程" });
    seen.add(key);
    if (!slot) issues.push({ severity: "error", code: "unknown_period", message: "找不到指定節次" });
    if (context.schedules.some(s => s.venueId === context.venue?.id && s.date === row.date && s.isClassLocked)) issues.push({ severity: "error", code: "locked", message: "目標日期課表已鎖定" });
    const before: ScheduleRow = matching ?? {
      id: `planned:${row.line}`, date: row.date, venueId: context.venue?.id ?? "", timeSlotId: slot?.id ?? "",
      className: null, coachName: null, coachName2: null, coachCount: 1, coach1IsTeaching: true,
      coach2IsTeaching: false, isClassLocked: false, notes: null, createdAt: null, updatedAt: null, version: 0,
    };
    const supplied = new Set(row.providedFields ?? ["date", "period", "className", "coachName", "coachName2", "coachCount", "notes"]);
    const values: SchedulePatch = { date: row.date, venueId: before.venueId, timeSlotId: slot?.id, className: row.className.trim() };
    for (const field of ["coachName", "coachName2", "coachCount", "notes"] as const) {
      if (!matching || supplied.has(field)) Object.assign(values, { [field]: row[field] });
    }
    if (values.coachName2 && values.coachCount === undefined && before.coachCount < 2) values.coachCount = 2;
    if (values.coachCount === 1 && matching && !supplied.has("coachName2")) {
      values.coachName2 = null; values.coach2IsTeaching = false;
    }
    Object.assign(values, preparePatch(before, values));
    const after = { ...before, ...values };
    if (sameCoach(after.coachName, after.coachName2)) issues.push({ severity: "error", code: "duplicate_coach", message: "同堂課不可指派相同教練兩次" });
    if (after.coachName2 && after.coachCount < 2) issues.push({ severity: "error", code: "coach_count", message: "第二位教練需要教練人數為二" });
    const status: PlanRow["status"] = matching && mode === "insert_only" ? "skip" : matching ? "update" : "create";
    const placed = newlyPlacedCoaches(before, after);
    if (status !== "skip") {
      for (const coach of placed) if (!approved.has(normalizeScheduleName(coach))) issues.push({ severity: "warning", code: "unknown_coach", message: `教練「${coach}」不在已核准名單` });
      const warnings = assignmentWarnings(after, placed, {
        sameDaySchedules: staged, timeSlots: context.slots,
        weekAvailability: context.availability.filter(a => a.weekStart === mondayOf(after.date)),
      });
      for (const warning of warnings) issues.push({ severity: "warning", code: warning.code === "COACH_CONFLICT" ? "coach_conflict" : "coach_unavailable", message: warning.message });
      const prior = staged.findIndex(s => s.id === after.id);
      const planned = { ...after, classKey: row.classKey, venue: context.venue ?? undefined };
      if (prior < 0) staged.push(planned); else staged[prior] = planned;
    }
    const changes = status === "skip" ? [] : Object.entries(values)
      .filter(([field, value]) => value !== undefined && before[field as keyof ScheduleRow] !== value)
      .map(([field, value]) => ({ field, before: before[field as keyof ScheduleRow] ?? null, after: value }));
    return { ...row, timeSlotId: slot?.id ?? null, status: issues.some(i => i.severity === "error") ? "error" : status,
      existingScheduleId: matching?.id ?? null, issues, values,
      clearedFields: changes.filter(c => c.before !== null && (c.after === null || c.after === "")).map(c => c.field), changes };
  });
  const summary = { total: rows.length, create: rows.filter(r => r.status === "create").length,
    update: rows.filter(r => r.status === "update").length, skip: rows.filter(r => r.status === "skip").length,
    error: rows.filter(r => r.status === "error").length + parseErrors.length,
    warning: rows.reduce((n, r) => n + r.issues.filter(i => i.severity === "warning").length, 0) };
  return { venue: context.venue, mode, rows, parseErrors, summary, canCommit: summary.error === 0 && summary.create + summary.update > 0 };
}

export interface CopyInput { sourceStartDate: string; sourceEndDate: string; targetStartDate: string; venueId: string }
export function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function validateCopyInput(input: CopyInput): void {
  for (const date of [input.sourceStartDate, input.sourceEndDate, input.targetStartDate]) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("INVALID_COPY_RANGE");
  }
  const span = (Date.parse(input.sourceEndDate) - Date.parse(input.sourceStartDate)) / 86_400_000;
  if (span < 0 || span > 6) throw new Error("INVALID_COPY_RANGE");
  if (input.sourceStartDate <= addUtcDays(input.targetStartDate, 6) && input.sourceEndDate >= input.targetStartDate) throw new Error("OVERLAPPING_COPY_RANGE");
}
export function planCopyWeek(input: CopyInput, schedules: KeyedSchedule[]) {
  validateCopyInput(input);
  const end = addUtcDays(input.targetStartDate, 6);
  const source = schedules.filter(s => s.venueId === input.venueId && s.date >= input.sourceStartDate && s.date <= input.sourceEndDate && !!s.className?.trim());
  const target = schedules.filter(s => s.venueId === input.venueId && s.date >= input.targetStartDate && s.date <= end);
  const rows: { sourceId: string; date: string; timeSlotId: string; className: string | null; values: SchedulePatch; issues: PlanIssue[]; clearedFields: string[]; status: "create" | "error"; changes: { field: string; before: unknown; after: unknown }[] }[] = [];
  const skippedRows: { sourceId: string; date: string; timeSlotId: string; className: string | null; status: "skip"; reason: string; issues: PlanIssue[]; changes: never[]; clearedFields: never[] }[] = [];
  let duplicateClassSkipped = 0, occupiedCellSkipped = 0;
  const plannedKeys = new Set<string>();
  for (const row of source) {
    const offset = (Date.parse(row.date) - Date.parse(input.sourceStartDate)) / 86_400_000;
    const date = addUtcDays(input.targetStartDate, offset), cell = target.filter(s => s.date === date && s.timeSlotId === row.timeSlotId);
    const key = JSON.stringify([date, row.timeSlotId, row.classKey]);
    if (cell.length || plannedKeys.has(key)) {
      const duplicate = cell.some(s => s.classKey === row.classKey) || plannedKeys.has(key);
      if (duplicate) duplicateClassSkipped++; else occupiedCellSkipped++;
      skippedRows.push({ sourceId: row.id, date, timeSlotId: row.timeSlotId, className: row.className, status: "skip", reason: duplicate ? "duplicate_class" : "occupied_cell", issues: [], changes: [], clearedFields: [] });
      continue;
    }
    plannedKeys.add(key);
    const issues: PlanIssue[] = target.some(s => s.date === date && s.isClassLocked) ? [{ severity: "error", code: "locked", message: "目標日期課表已鎖定" }] : [];
    rows.push({ sourceId: row.id, date, timeSlotId: row.timeSlotId, className: row.className, issues, status: issues.length ? "error" : "create",
      changes: [{field:"className",before:null,after:row.className}, ...(["coachName", "coachName2", "notes"] as const).filter(f => !!row[f]).map(f => ({field:f,before:row[f],after:null}))],
      values: { date, venueId: input.venueId, timeSlotId: row.timeSlotId, className: row.className,
        coachName: null, coachName2: null, coachCount: row.coachCount, coach1IsTeaching: true, coach2IsTeaching: false, notes: null },
      clearedFields: [row.coachName ? "coachName" : null, row.coachName2 ? "coachName2" : null, row.notes ? "notes" : null].filter((f): f is string => !!f) });
  }
  const error = rows.filter(r => r.issues.length).length;
  return { sourceCount: source.length, plannedCount: rows.length, duplicateClassSkipped, occupiedCellSkipped,
    targetEndDate: end, items: rows.map(r => ({ date: r.date, timeSlotId: r.timeSlotId, className: r.className })), rows, skippedRows,
    summary: { total: source.length, create: rows.length, update: 0, skip: duplicateClassSkipped + occupiedCellSkipped, error, warning: 0 },
    canCommit: rows.length > 0 && error === 0 };
}
