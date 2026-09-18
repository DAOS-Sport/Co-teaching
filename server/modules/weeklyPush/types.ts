/**
 * Type aliases shared by the weekly push module (Task #23).
 *
 * Centralizing the literal-union shapes here keeps producers, the
 * worker handlers, the repository, and the routes in lockstep with
 * the values stored in `weekly_push_runs.status` and
 * `weekly_push_recipients.status`.
 */

export type WeeklyPushType = "weekly";
export type WeeklyPushTriggerSource = "cron" | "manual" | "retry";
export type WeeklyPushRunStatus =
  | "queued"
  | "preparing"
  | "sending"
  | "reconciling"
  | "success"
  | "partial_success"
  | "failed"
  | "cancelled";
export type WeeklyPushRecipientStatus =
  | "pending"
  | "sending"
  | "success"
  | "retry_wait"
  | "failed"
  | "cancelled"
  | "skipped";

/** Job payload for the weekly-push orchestrator queue. */
export interface WeeklyPushJobData {
  runId: string;
}

/** Job payload for the per-recipient send queue. */
export interface WeeklyPushRecipientJobData {
  runId: string;
  recipientId: string;
}

/** Job payload for the post-run report generator queue. */
export interface WeeklyPushReportJobData {
  runId: string;
}
