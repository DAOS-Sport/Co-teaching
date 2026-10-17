/** Core-owned scheduling contracts. Source shape: shared/schema.ts at c8301a6. */
export interface ScheduleRow {
  id: string;
  date: string;
  venueId: string;
  timeSlotId: string;
  className: string | null;
  coachName: string | null;
  coachName2: string | null;
  coach1IsTeaching: boolean;
  coach2IsTeaching: boolean;
  coachCount: number;
  isClassLocked: boolean;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  version: number;
}

export type SchedulePatch = Partial<Pick<ScheduleRow,
  | "date" | "venueId" | "timeSlotId" | "className"
  | "coachName" | "coachName2" | "coach1IsTeaching" | "coach2IsTeaching"
  | "coachCount" | "isClassLocked" | "notes"
>>;

export type MutationKind = "updateSchedule" | "assignCoach" | "createSchedule";
export type AssignmentWarningCode = "COACH_CONFLICT" | "COACH_UNAVAILABLE";

export interface AssignmentWarning {
  code: AssignmentWarningCode;
  coachName: string;
  message: string;
}

export interface ScheduleContextRow {
  id: string;
  date: string;
  venueId: string;
  timeSlotId: string;
  className: string | null;
  coachName: string | null;
  coachName2: string | null;
  isClassLocked: boolean;
  version: number;
  venue?: { name?: string | null } | null;
}

export interface AvailabilityRow {
  coachName: string;
  dayOfWeek: number;
  timeSlotOrder: number;
}

export interface TimeSlotRow { id: string; order: number }

export interface AssignmentContext {
  sameDaySchedules: ScheduleContextRow[];
  timeSlots: TimeSlotRow[];
  weekAvailability: AvailabilityRow[];
}

export interface AssignmentContextQuery {
  date: string;
  venueId: string;
  timeSlotId: string;
  weekStart: string;
}

export interface AuditContext {
  actor: string;
  requestId: string | null;
  reason?: string;
}

export interface ScheduleMutationInput {
  scheduleId: string;
  expectedVersion?: number | null;
  patch: SchedulePatch;
  confirmWarnings?: unknown;
  confirmationToken?: string | null;
  auditContext: AuditContext;
}

export type CanonicalPatch = Record<string, string | number | boolean | null>;

/** All values are JSON data; signing, canonical serialization and expiry are outer concerns. */
export interface ConfirmationContext {
  kind: MutationKind;
  scheduleId: string;
  version: number;
  canonicalPatch: CanonicalPatch;
  warningSnapshot: {
    schedules: {
      id: string;
      date: string;
      venueId: string;
      timeSlotId: string;
      className: string | null;
      coachName: string | null;
      coachName2: string | null;
      version: number;
      isClassLocked: boolean;
      venueName: string | null;
    }[];
    timeSlot: TimeSlotRow | null;
    availability: AvailabilityRow[];
  };
  warnings: AssignmentWarning[];
}

export interface ScheduleAuditEntry {
  kind: MutationKind;
  context: AuditContext;
  before: ScheduleRow;
  after: ScheduleRow;
}

export type ScheduleMutationErrorCode =
  | "SCHEDULE_NOT_FOUND" | "VERSION_REQUIRED" | "VERSION_CONFLICT"
  | "DUPLICATE_COACH" | "SCHEDULE_LOCKED" | "CONFIRM_REQUIRED";

const ERROR_MESSAGES: Record<ScheduleMutationErrorCode, string> = {
  SCHEDULE_NOT_FOUND: "Schedule not found",
  VERSION_REQUIRED: "請重新整理頁面後再操作",
  VERSION_CONFLICT: "這筆課程剛被其他人修改過，畫面已重新整理，請確認後再操作一次",
  DUPLICATE_COACH: "同一堂課不可指派同一位教練兩次",
  SCHEDULE_LOCKED: "課表已鎖定，請先解鎖該週才能新增或修改課程名稱",
  CONFIRM_REQUIRED: "請確認教練的衝堂或可排時段警告後再儲存",
};

export class ScheduleMutationError extends Error {
  readonly code: ScheduleMutationErrorCode;
  readonly warnings?: AssignmentWarning[];
  readonly confirmationToken?: string;

  constructor(code: ScheduleMutationErrorCode, details?: {
    warnings: AssignmentWarning[];
    confirmationToken: string;
  }) {
    super(code === "CONFIRM_REQUIRED" && details
      ? details.warnings.length > 0
        ? `需要確認：${details.warnings.map((warning) => warning.message).join("；")}`
        : "課表或警告資料已變更，請重新確認"
      : ERROR_MESSAGES[code]);
    this.name = "ScheduleMutationError";
    this.code = code;
    this.warnings = details?.warnings;
    this.confirmationToken = details?.confirmationToken;
  }
}
