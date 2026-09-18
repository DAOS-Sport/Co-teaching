import cron from "node-cron";
import { weeklyPushRepo } from "./weeklyPush.repository";
import type { WeeklyPushRunStatus } from "./types";
import { dispatchWeeklyPushOutbox } from "./weeklyPush.outbox";
import { enqueueRecipientJob } from "./weeklyPush.service";

export async function reconcileWeeklyPushRun(runId: string) {
  const run = await weeklyPushRepo.getRunById(runId);
  if (!run || run.status === "cancelled") return run;

  // A process can die after persisting `sending` but before pg-boss records
  // completion. Redrive stale rows with the original stored LINE retry key.
  const stuck = await weeklyPushRepo.listStuckSendingRecipients(
    runId,
    new Date(Date.now() - 10 * 60 * 1000),
  );
  for (const recipient of stuck) {
    await weeklyPushRepo.updateRecipient(recipient.id, {
      status: "retry_wait",
      nextRetryAt: new Date(),
      errorCode: "stuck_sending",
      errorMessage: "reconciliation redrive after worker interruption",
    });
    await enqueueRecipientJob(runId, recipient.id);
  }

  const counts = await weeklyPushRepo.countRecipientStatuses(runId);
  const unsettled = counts.pending + counts.sending + counts.retryWait;
  let status = run.status as WeeklyPushRunStatus;
  if (unsettled > 0) status = "reconciling";
  else if (counts.failed === 0) status = "success";
  else if (counts.success > 0 || counts.skipped > 0) status = "partial_success";
  else status = "failed";

  return weeklyPushRepo.updateRun(runId, {
    status,
    totalCount: counts.total,
    successCount: counts.success,
    failureCount: counts.failed,
    skippedCount: counts.skipped,
    completedAt: unsettled === 0 ? new Date() : undefined,
  });
}

export function setupWeeklyPushReconciliation(): void {
  cron.schedule("*/5 * * * *", () => {
    dispatchWeeklyPushOutbox()
      .then(() => weeklyPushRepo
      .listRunsByStatuses(["queued", "preparing", "sending", "reconciling", "failed"])
      .then((runs) => Promise.all(runs.map((run) => reconcileWeeklyPushRun(run.id)))))
      .catch((err) => console.error("[weeklyPush.reconcile] failed", err));
  });
}
