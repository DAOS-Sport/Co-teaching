/** Request-scoped notification units. No timers, transport, queue client or database is opened here. */
export interface NotificationBatchControl {
  signal?: AbortSignal;
  /** Absolute trusted-server clock deadline, in milliseconds since epoch. */
  deadlineMs?: number;
  now?: () => number;
  shouldContinue?: () => boolean;
}

export interface NotificationBatchOptions extends NotificationBatchControl {
  limit?: number;
  /** Last visited saved recipient ID. Persist this with the parent job before acknowledging it. */
  cursor?: string | null;
}

export interface SavedNotificationRun { id: string; dryRun: boolean }
export interface SavedNotificationRecipient {
  id: string;
  runId: string;
  status: string;
  nextRetryAt?: Date | string | null;
}

export interface NotificationFanoutDependencies {
  getRunById(id: string, control?: NotificationBatchControl): Promise<SavedNotificationRun | null>;
  listRecipientsByRun(id: string, control?: NotificationBatchControl): Promise<SavedNotificationRecipient[]>;
  /** Adapter must use the existing deterministic recipient job identity (manualRetry=false). */
  enqueueRecipientJob(runId: string, recipientId: string, control?: NotificationBatchControl): Promise<unknown>;
  updateRecipient(id: string, patch: { status: "skipped"; completedAt: Date }, control?: NotificationBatchControl): Promise<unknown>;
}

export interface BoundedRecipientDependencies {
  getRunById(id: string, control?: NotificationBatchControl): Promise<SavedNotificationRun | null>;
  getRecipientById(id: string, control?: NotificationBatchControl): Promise<SavedNotificationRecipient | null>;
  updateRecipient(id: string, patch: { status: "skipped"; completedAt: Date }, control?: NotificationBatchControl): Promise<unknown>;
  /** Existing claim/fence/retry-window implementation, operating only on its saved payload and LINE key. */
  deliverSavedRecipient(id: string, control?: NotificationBatchControl): Promise<{ state: string; retry: boolean }>;
}

export function notificationBatchMayContinue(control: NotificationBatchControl): boolean {
  if (control.signal?.aborted) return false;
  if (control.deadlineMs !== undefined) {
    if (!Number.isFinite(control.deadlineMs)) throw new Error("invalid_notification_deadline");
    if ((control.now ?? Date.now)() >= control.deadlineMs) return false;
  }
  return control.shouldContinue?.() !== false;
}

export function notificationBatchLimit(limit = 25): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error("invalid_notification_batch_limit");
  return limit;
}

function retryable(row: SavedNotificationRecipient): boolean {
  return ["pending", "processing", "sending", "retry_wait"].includes(row.status)
    || (row.status === "unknown" && row.nextRetryAt != null);
}

/** Weekly and generic notification-delivery parents share the same saved-recipient fanout. */
export async function fanoutWeeklyRun(runId: string, dependencies: NotificationFanoutDependencies, options: NotificationBatchOptions = {}) {
  const limit = notificationBatchLimit(options.limit);
  if (options.cursor !== undefined && options.cursor !== null && typeof options.cursor !== "string") throw new Error("invalid_notification_fanout_cursor");
  let cursor = options.cursor ?? null;
  let queued = 0, visited = 0;
  const stopped = (dryRun = false) => ({ queued, visited, pending: null as number | null, nextCursor: cursor, complete: false, dryRun });
  if (!notificationBatchMayContinue(options)) return stopped();
  const run = await dependencies.getRunById(runId, options);
  if (!run) throw new Error("weekly_push_run_not_found");
  if (run.id !== runId) throw new Error("notification_run_identity_mismatch");
  if (!notificationBatchMayContinue(options)) return stopped(run.dryRun);
  const saved = await dependencies.listRecipientsByRun(runId, options);
  if (saved.some(row => row.runId !== runId)) throw new Error("notification_recipient_run_mismatch");
  if (new Set(saved.map(row => row.id)).size !== saved.length) throw new Error("duplicate_saved_notification_recipient");
  const remaining = saved.filter(row => cursor === null || row.id > cursor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const row of remaining) {
    if (visited >= limit || !notificationBatchMayContinue(options)) break;
    if (retryable(row)) {
      if (run.dryRun) await dependencies.updateRecipient(row.id, { status: "skipped", completedAt: new Date((options.now ?? Date.now)()) }, options);
      else { await dependencies.enqueueRecipientJob(runId, row.id, options); queued++; }
    }
    // Advance only after the selected write has settled. No Promise.race or detached work.
    visited++;
    cursor = row.id;
  }
  const pending = remaining.length - visited;
  return { queued, visited, pending, nextCursor: pending === 0 ? null : cursor, complete: pending === 0, dryRun: run.dryRun };
}

export const fanoutNotificationRun = fanoutWeeklyRun;

export interface BoundedRecipientResult { state: string; retry: boolean; settled: boolean; stopped: boolean }

/** Exactly one saved recipient; report/summary/run finalization belong to another bounded unit. */
export async function handleBoundedRecipient(input: { runId: string; recipientId: string }, dependencies: BoundedRecipientDependencies, control: NotificationBatchControl = {}): Promise<BoundedRecipientResult> {
  const stopped = (): BoundedRecipientResult => ({ state: "stopped", retry: true, settled: false, stopped: true });
  if (!notificationBatchMayContinue(control)) return stopped();
  const run = await dependencies.getRunById(input.runId, control);
  if (!run) throw new Error("weekly_push_run_not_found");
  if (run.id !== input.runId) throw new Error("notification_run_identity_mismatch");
  if (!notificationBatchMayContinue(control)) return stopped();
  const row = await dependencies.getRecipientById(input.recipientId, control);
  if (!row) throw new Error("notification_recipient_not_found");
  if (row.id !== input.recipientId) throw new Error("notification_recipient_identity_mismatch");
  if (row.runId !== input.runId) throw new Error("notification_recipient_run_mismatch");
  if (!notificationBatchMayContinue(control)) return stopped();
  if (run.dryRun) {
    if (retryable(row)) await dependencies.updateRecipient(row.id, { status: "skipped", completedAt: new Date((control.now ?? Date.now)()) }, control);
    return { state: "skipped", retry: false, settled: true, stopped: false };
  }
  if (!retryable(row)) return { state: row.status, retry: false, settled: true, stopped: false };
  if (row.nextRetryAt != null) {
    const retryAt = new Date(row.nextRetryAt).getTime();
    if (!Number.isFinite(retryAt)) throw new Error("invalid_saved_notification_retry_at");
    if ((control.now ?? Date.now)() < retryAt) return { state: row.status, retry: true, settled: false, stopped: false };
  }
  const result = await dependencies.deliverSavedRecipient(row.id, control);
  if (result.state !== "unclaimed") return { ...result, settled: !result.retry, stopped: false };
  if (!notificationBatchMayContinue(control)) return stopped();
  const current = await dependencies.getRecipientById(row.id, control);
  if (!current) throw new Error("notification_recipient_not_found");
  if (current.id !== row.id || current.runId !== input.runId) throw new Error("notification_recipient_run_mismatch");
  const retry = retryable(current);
  return { state: current.status, retry, settled: !retry, stopped: false };
}
