export type SaveState = "dirty" | "saving" | "saved" | "error" | "conflict";

export function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value;
}
export function localDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function monday(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - (result.getDay() + 6) % 7);
  return result;
}
export function readScheduleLocation(search: string, fallback = new Date()): { venueId: string; week: Date } {
  const params = new URLSearchParams(search);
  const venue = params.get("venueId") ?? "";
  const week = params.get("week") ?? "";
  return { venueId: /^[A-Za-z0-9_-]{1,128}$/.test(venue) ? venue : "", week: monday(validDateOnly(week) ? new Date(`${week}T12:00:00`) : fallback) };
}
/** Only public filter keys enter history; passwords, tokens and text never do. */
export function scheduleLocation(pathname: string, venueId: string, week: Date): string {
  const params = new URLSearchParams();
  if (/^[A-Za-z0-9_-]{1,128}$/.test(venueId)) params.set("venueId", venueId);
  params.set("week", localDate(monday(week)));
  return `${pathname}?${params.toString()}`;
}

export type PlanIssue = { severity: "error" | "warning"; code: string; message: string };
export type PlanChange = { field: string; before: unknown; after: unknown };
export type BatchPreviewRow = {
  line?: number; sourceId?: string; date: string; period?: number; timeSlotId?: string | null;
  className: string | null; coachName?: string | null; coachName2?: string | null;
  status?: "create" | "update" | "skip" | "error"; reason?: string;
  issues?: PlanIssue[]; changes?: PlanChange[]; clearedFields?: string[];
};
export type BatchPreview = {
  rows: BatchPreviewRow[]; skippedRows?: BatchPreviewRow[];
  parseErrors?: { line: number; message: string }[];
  summary: { total: number; create: number; update: number; skip: number; error: number; warning: number };
  canCommit: boolean; confirmationToken?: string;
};
export type BoundPreview<T extends BatchPreview = BatchPreview> = { value: T; context: string };
export function batchContext(input: Record<string, string>): string {
  return JSON.stringify(Object.keys(input).sort().map((key) => [key, input[key]]));
}
export function bindPreview<T extends BatchPreview>(value: T, context: string): BoundPreview<T> { return { value, context }; }
export function canCommitPreview(bound: BoundPreview | null, context: string): boolean {
  return !!bound && bound.context === context && bound.value.canCommit && typeof bound.value.confirmationToken === "string" && bound.value.confirmationToken.length > 0;
}
export function previewCommitToken(bound: BoundPreview | null, context: string): string {
  if (!canCommitPreview(bound, context)) throw Object.assign(new Error("輸入或預覽已變更，請重新預覽確認。"), { code: "PREVIEW_REQUIRED" });
  return bound!.value.confirmationToken!;
}
export function previewRows(preview: BatchPreview): (BatchPreviewRow & { status: "create" | "update" | "skip" | "error" })[] {
  return [...preview.rows, ...(preview.skippedRows ?? [])].map((row) => ({ ...row,
    status: row.status ?? ((row.issues ?? []).some((issue) => issue.severity === "error") ? "error" : "create"),
  }));
}
export const fieldLabels: Record<string, string> = {
  date: "日期", venueId: "場館", timeSlotId: "節次", className: "班別", coachName: "教練一", coachName2: "教練二",
  coachCount: "教練人數", coach1IsTeaching: "教練一教學", coach2IsTeaching: "教練二教學", notes: "備註",
};
export function displayField(value: unknown): string {
  if (value === null || value === undefined || value === "") return "空白";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "string" ? value : JSON.stringify(value);
}
export function clearSubmittedDraft<T>(drafts: Record<string, T>, key: string, submitted: T): Record<string, T> {
  if (drafts[key] !== submitted) return drafts;
  const next = { ...drafts }; delete next[key]; return next;
}
export function remainingDraft<T extends Record<string, unknown>>(current: T, submitted: Record<string, unknown>): Partial<T> {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => !(key in submitted) || submitted[key] !== value)) as Partial<T>;
}
export function scheduleCellKey(venueId: string, date: string, slot: string): string { return JSON.stringify([venueId, date, slot]); }
export function failedSaveState(error: unknown): "conflict" | "error" {
  return error && typeof error === "object" && (error as { code?: unknown }).code === "VERSION_CONFLICT" ? "conflict" : "error";
}
export type AssignmentPatch = Partial<{ coachName: string; coachName2: string; coach1IsTeaching: boolean; coach2IsTeaching: boolean }>;
export function assignmentChanges(before: object, after: object): PlanChange[] {
  const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
  return ["coachName", "coachName2", "coach1IsTeaching", "coach2IsTeaching"].filter((field) => left[field] !== right[field])
    .map((field) => ({ field, before: left[field], after: right[field] }));
}
export const ordinarySaveReceipt = "課表已儲存；未安排通知。";
export function notificationReceiptLabel(status?: string): string {
  switch (status) {
    case "pending": case "queued": return "通知已排入佇列，尚未受理";
    case "accepted": return "LINE 已受理，不代表已送達";
    case "unknown": return "通知結果未確認，尚未證實 LINE 受理";
    case "not_configured": return "通知未設定，未安排傳送";
    case "unchanged": return "課表狀態未變，沒有新增通知";
    default: return "未安排通知";
  }
}

/** Summaries distinguish platform acceptance, unresolved results and work still in progress. */
export function summarizeNotificationRecipients(recipients: readonly { status: string }[]) {
  const counts = { total: recipients.length, success: 0, failed: 0, skipped: 0, pending: 0, unknown: 0 };
  for (const { status } of recipients) {
    if (status === "accepted" || status === "success") counts.success++;
    else if (status === "failed") counts.failed++;
    else if (status === "skipped") counts.skipped++;
    else if (["pending", "queued", "processing", "sending", "retry_wait"].includes(status)) counts.pending++;
    else counts.unknown++;
  }
  return counts;
}
