import { finalizeWeeklyPushRun } from "./weeklyPush.worker";
import { weeklyPushRepo } from "./weeklyPush.repository";
import { enqueueRecipientJob } from "./weeklyPush.service";

export async function reconcileWeeklyPushRun(runId: string) {
  const run = await weeklyPushRepo.getRunById(runId);
  if (!run) return null;
  const recipients = await weeklyPushRepo.listRecipientsByRun(runId);
  let retryScheduled = false;
  for (const recipient of recipients) {
    if (["pending", "processing", "sending", "retry_wait"].includes(recipient.status) || (recipient.status === "unknown" && recipient.nextRetryAt)) {
      await enqueueRecipientJob(runId, recipient.id);
      retryScheduled = true;
    }
  }
  const counts = await weeklyPushRepo.countRecipientStatuses(runId);
  const unsettled = counts.pending + counts.sending + counts.retryWait;
  if (unsettled > 0 || retryScheduled) return weeklyPushRepo.updateRun(runId, { status: "sending", totalCount: counts.total, successCount: counts.success,
    failureCount: counts.failed, skippedCount: counts.skipped, completedAt: null });
  if (["success", "partial_success", "failed", "unknown"].includes(run.status) && run.completedAt && (run.pushType !== "weekly" || run.reportPath)) return run;
  return finalizeWeeklyPushRun(run, counts);
}

export async function setupWeeklyPushReconciliation() {
  const { configureNotificationSchedules } = await import("../../infra/queue/runtime");
  return configureNotificationSchedules({ enabled: true, kinds: ["reconcile"] });
}
