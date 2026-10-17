import type PgBoss from "pg-boss";
import { startBoss, getBoss, stopBoss, getQueueProducer } from "../../infra/queue/boss";
import { queues } from "../../infra/queue/queues";
import { pingFail, pingStart, pingSuccess } from "../../infra/healthchecks/healthchecks.client";
import { deliverSavedRecipient } from "../notification/delivery.service";
import { pushRunSummary } from "../notification/notification.service";
import { weeklyPushRepo } from "./weeklyPush.repository";
import { generateAndStoreReport } from "./weeklyPush.report";
import type { WeeklyPushJobData, WeeklyPushRecipientJobData, WeeklyPushReportJobData } from "./types";

const WEEKLY_PUSH_MONITOR_FAILURE = "weekly_push_job_failed";
const WEEKLY_PUSH_MONITOR_INCOMPLETE = "weekly_push_job_incomplete";
const WEEKLY_PUSH_FINALIZATION_FAILURE = "weekly_push_finalization_failed";

let workersRegistered = false;
let registeredBoss: PgBoss | null = null;
let registrationPromise: Promise<void> | null = null;

export function areWeeklyPushWorkersReady(): boolean {
  return workersRegistered && registeredBoss === getQueueProducer();
}

type Run = NonNullable<Awaited<ReturnType<typeof weeklyPushRepo.getRunById>>>;
type Counts = Awaited<ReturnType<typeof weeklyPushRepo.countRecipientStatuses>>;

/** Recipient success means platform acceptance; report completion is a separate gate. */
export async function finalizeWeeklyPushRun(run: Run, counts: Counts, options: { monitor?: boolean } = {}) {
  const status = counts.unknown > 0 ? "unknown" : counts.failed > 0
    ? (counts.success > 0 ? "partial_success" : "failed") : "success";
  const totals = { totalCount: counts.total, successCount: counts.success, failureCount: counts.failed, skippedCount: counts.skipped };
  let failureStatus: "failed" | "unknown" = "failed";
  const monitor = run.pushType === "weekly" && options.monitor !== false;
  if (monitor) await pingStart();
  try {
    const preparing = await weeklyPushRepo.updateRun(run.id, { ...totals, status: "sending", completedAt: null, errorMessage: null });
    if (!preparing) throw new Error(WEEKLY_PUSH_FINALIZATION_FAILURE);
    if (run.pushType === "weekly") await generateAndStoreReport(run.id);
    const finalPatch = {
      ...totals, status, completedAt: new Date(),
      errorMessage: counts.unknown > 0 ? "Platform acceptance could not be confirmed." : null,
    } satisfies Parameters<typeof weeklyPushRepo.updateRun>[1];
    if (run.pushType === "weekly") {
      const summary = await pushRunSummary({ run: { ...preparing, ...finalPatch }, recipients: await weeklyPushRepo.listRecipientsByRun(run.id) });
      if (summary.configuredCount > 0 && summary.status !== "accepted") {
        failureStatus = summary.status === "unknown" ? "unknown" : "failed";
        throw new Error("weekly_push_summary_not_accepted");
      }
    }
    const updated = await weeklyPushRepo.updateRun(run.id, finalPatch);
    if (!updated) throw new Error(WEEKLY_PUSH_FINALIZATION_FAILURE);
    if (monitor) {
      if (updated.status === "success") await pingSuccess("weekly_push_completed_platform_acceptance_only");
      else await pingFail(WEEKLY_PUSH_MONITOR_INCOMPLETE);
    }
    return updated;
  } catch (error) {
    // Preserve recipient identities and accepted/unknown records for a report-only retry.
    try {
      await weeklyPushRepo.updateRun(run.id, { ...totals, status: failureStatus, completedAt: null, errorMessage: WEEKLY_PUSH_FINALIZATION_FAILURE });
    } finally {
      if (monitor) await pingFail(WEEKLY_PUSH_MONITOR_FAILURE);
    }
    throw error;
  }
}

export async function handleWeeklyPushJob(jobs: PgBoss.Job<WeeklyPushJobData>[]) {
  for (const job of jobs) {
    let monitor = false;
    try {
      const run = await weeklyPushRepo.getRunById(job.data.runId);
      if (!run) throw new Error("weekly_push_run_not_found");
      monitor = run.pushType === "weekly";
      if (monitor) await pingStart();
      await weeklyPushRepo.updateRun(run.id, { status: "sending", startedAt: run.startedAt ?? new Date(), completedAt: null });
      const recipients = await weeklyPushRepo.listRecipientsByRun(run.id);
      let retry = false;
      for (const recipient of recipients) {
        if (run.dryRun) {
          await weeklyPushRepo.updateRecipient(recipient.id, { status: "skipped", completedAt: new Date() });
          continue;
        }
        const result = await deliverSavedRecipient(recipient.id);
        if (result.retry) retry = true;
        if (result.state === "unclaimed") {
          const current = await weeklyPushRepo.getRecipientById(recipient.id);
          if (current && (["pending", "processing", "sending", "retry_wait"].includes(current.status) || (current.status === "unknown" && current.nextRetryAt))) retry = true;
        }
      }
      const counts = await weeklyPushRepo.countRecipientStatuses(run.id);
      if (retry || counts.pending + counts.sending + counts.retryWait > 0) throw new Error("weekly_push_recipients_unsettled");
      const updated = await finalizeWeeklyPushRun(run, counts, { monitor: false });
      if (monitor) {
        if (updated.status === "success") await pingSuccess("weekly_push_completed_platform_acceptance_only");
        else await pingFail(WEEKLY_PUSH_MONITOR_INCOMPLETE);
      }
    } catch (error) {
      if (!monitor && job.name === queues.weeklyPush) { monitor = true; await pingStart(); }
      if (monitor) await pingFail(WEEKLY_PUSH_MONITOR_FAILURE);
      throw error;
    }
  }
}

export async function handleRecipientJob(jobs: PgBoss.Job<WeeklyPushRecipientJobData>[]) {
  for (const job of jobs) {
    const result = await deliverSavedRecipient(job.data.recipientId);
    if (result.retry) throw new Error("Saved delivery remains retryable with its original LINE key");
    if (result.state === "unclaimed") {
      const row = await weeklyPushRepo.getRecipientById(job.data.recipientId);
      if (row && (["pending", "processing", "sending", "retry_wait"].includes(row.status) || (row.status === "unknown" && row.nextRetryAt))) {
        throw new Error("Saved delivery is not ready; retain the existing retry identity");
      }
    }
    const run = await weeklyPushRepo.getRunById(job.data.runId);
    if (!run) throw new Error("weekly_push_run_not_found");
    const counts = await weeklyPushRepo.countRecipientStatuses(run.id);
    const recipients = await weeklyPushRepo.listRecipientsByRun(run.id);
    if (counts.pending + counts.sending + counts.retryWait === 0 && !recipients.some(row => row.status === "unknown" && row.nextRetryAt)) {
      await finalizeWeeklyPushRun(run, counts);
    }
  }
}

export async function handleReportJob(jobs: PgBoss.Job<WeeklyPushReportJobData>[]) {
  for (const job of jobs) await generateAndStoreReport(job.data.runId);
}

/** Explicit worker registration only; application boot must not invoke this. */
export async function startWeeklyPushWorkers(): Promise<void> {
  if (registrationPromise) return registrationPromise;
  registrationPromise = (async () => {
    await startBoss();
    const boss = getBoss();
    if (workersRegistered && registeredBoss === boss) return;
    try {
      await boss.createQueue(queues.weeklyPush);
      await boss.createQueue(queues.weeklyPushRecipient);
      await boss.createQueue(queues.weeklyPushReport);
      await boss.work(queues.weeklyPush, { batchSize: 1 }, handleWeeklyPushJob);
      await boss.work(queues.weeklyPushRecipient, { batchSize: 1, includeMetadata: true }, handleRecipientJob);
      await boss.work(queues.weeklyPushReport, { batchSize: 1 }, handleReportJob);
      registeredBoss = boss;
      workersRegistered = true;
    } catch (error) {
      workersRegistered = false;
      registeredBoss = null;
      await stopBoss();
      throw error;
    }
  })();
  try { await registrationPromise; } finally { registrationPromise = null; }
}
