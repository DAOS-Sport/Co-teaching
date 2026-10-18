/** Domain projections: no database models or queue types cross this boundary. */
export interface WeekRange { weekStartDate: string; weekEndDate: string }
export interface WeeklyCoach { id: string; name: string | null; linkedCoachName: string | null; lineId: string | null }
export interface WeeklySchedule {
  date: string; coachName: string | null; coachName2: string | null;
  venue: { name: string }; timeSlot: { startTime: string; endTime: string; order: number };
  className: string | null;
}
export interface WeeklyMessageItem {
  date: string; venueName: string; timeSlotLabel: string; className: string | null; timeSlotOrder: number;
}
export interface BuiltWeeklyRecipient {
  recipientName: string; recipientId: string; lineUserId: string;
  scheduleCount: number; payload: { message: string; scheduleCount: number };
}
export interface EnqueueWeeklyParams {
  latestCreateAt?: number; weekStartDate?: string; weekEndDate?: string;
  dryRun?: boolean; triggerSource?: 'cron' | 'manual' | 'retry';
}
export interface WeeklyRun { id: string; dryRun: boolean }
export interface NewWeeklyRun extends WeeklyRun, WeekRange {
  pushType: 'weekly'; triggerSource: 'cron' | 'manual' | 'retry';
  destination: 'coaches'; idempotencyKey: string; status: 'queued'; totalCount: number;
}
export interface NewWeeklyRecipient {
  runId: string; recipientType: 'coach'; recipientId: string; recipientName: string;
  lineUserId: string; status: 'skipped' | 'pending'; deliveryKey: string; lineRetryKey: string;
  payloadJson: { message: string; scheduleCount: number; messageVersion: number; capturedAt: string };
}
export interface WeeklyEnqueueResult<Run extends WeeklyRun> {
  run: Run; reused: boolean; recipientsCreated: number;
}
