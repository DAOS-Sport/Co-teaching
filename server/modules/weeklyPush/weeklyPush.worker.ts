/**
 * pg-boss worker handlers for the weekly push pipeline (Task #23).
 *
 * Three handlers are registered against the queues from
 * `infra/queue/queues`:
 *
 *   - weekly-push          : orchestrator. Pings Healthchecks /start,
 *                            marks the run running, fans out per-recipient
 *                            jobs (or short-circuits for dry-run), polls
 *                            until pending===0 or the workload-aware
 *                            timeout fires. If pending recipients remain
 *                            after the timeout the run is forced to
 *                            'failed' with errorMessage='orchestrator_timeout'
 *                            and Healthchecks is pinged /fail — the run is
 *                            never reported as success while work is still
 *                            in flight. The CSV report and the LINE summary
 *                            are always emitted last (after the run row is
 *                            in its final state) so what observers see
 *                            matches the DB.
 *
 *   - weekly-push-recipient: sends the LINE message for a single
 *                            recipient and updates that row's status.
 *                            Uses pg-boss native retries; only the
 *                            final attempt marks the row as 'failed'.
 *                            Hard input errors (no LINE id / bad
 *                            payload) are marked failed immediately
 *                            and not retried.
 *
 *   - weekly-push-report   : generates / re-generates the CSV report
 *                            for an existing run on demand.
 */
import type PgBoss from "pg-boss";
import { startBoss, getBoss } from "../../infra/queue/boss";
import { queues } from "../../infra/queue/queues";
import {
  pingFail,
  pingStart,
  pingSuccess,
} from "../../infra/healthchecks/healthchecks.client";
import { weeklyPushRepo } from "./weeklyPush.repository";
import { generateAndStoreReport } from "./weeklyPush.report";
import {
  enqueueRecipientJob,
  RECIPIENT_RETRY_LIMIT,
  RECIPIENT_RETRY_DELAY_SECONDS,
} from "./weeklyPush.service";
import { sendTextMessage } from "../notification/lineNotify.adapter";
import { pushRunSummary } from "../notification/notification.service";
import type {
  WeeklyPushJobData,
  WeeklyPushRecipientJobData,
  WeeklyPushReportJobData,
} from "./types";

const ORCHESTRATOR_POLL_MS = 2_000;

// Worst-case for one recipient with native pg-boss retries (limit=3, delay=60s, backoff):
// 60 + 120 + 240 = 420s of wait, plus per-attempt processing.
const RECIPIENT_RETRY_BUDGET_MS =
  RECIPIENT_RETRY_DELAY_SECONDS *
  (Math.pow(2, RECIPIENT_RETRY_LIMIT) - 1) *
  1_000;
const PER_RECIPIENT_PROCESS_MS = 2_000;
const ORCHESTRATOR_BASE_SLACK_MS = 60_000;
const ORCHESTRATOR_HARD_CAP_MS = 30 * 60 * 1_000;

/**
 * Workload-aware orchestrator timeout. Scales with recipient count so a
 * large roster (especially one hitting LINE retries) doesn't time out
 * before pg-boss exhausts its retry budget. Capped at 30 minutes so a
 * pathologically large run can't wedge the worker forever.
 */
function computeOrchestratorMaxWaitMs(recipientCount: number): number {
  const ms =
    RECIPIENT_RETRY_BUDGET_MS +
    PER_RECIPIENT_PROCESS_MS * recipientCount +
    ORCHESTRATOR_BASE_SLACK_MS;
  return Math.min(ms, ORCHESTRATOR_HARD_CAP_MS);
}

let workersRegistered = false;

export function areWeeklyPushWorkersReady(): boolean {
  return workersRegistered;
}

interface RecipientPayload {
  message: string;
  scheduleCount: number;
}

function readRecipientPayload(value: unknown): RecipientPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.message !== "string") return null;
  return {
    message: v.message,
    scheduleCount: typeof v.scheduleCount === "number" ? v.scheduleCount : 0,
  };
}

/**
 * Polls the recipients table until `pending === 0` or `maxWaitMs`
 * elapses. Returns whether the wait completed cleanly so the
 * orchestrator can branch on success vs timeout.
 */
async function waitForRecipientsToFinish(
  runId: string,
  maxWaitMs: number,
): Promise<{ pendingDrained: boolean; waitedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const counts = await weeklyPushRepo.countRecipientStatuses(runId);
    if (counts.pending + counts.sending + counts.retryWait === 0) {
      return { pendingDrained: true, waitedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, ORCHESTRATOR_POLL_MS));
  }
  return { pendingDrained: false, waitedMs: Date.now() - start };
}

async function handleWeeklyPushJob(
  jobs: PgBoss.Job<WeeklyPushJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const { runId } = job.data;
    console.log(`[weeklyPush.worker] start orchestrator runId=${runId}`);
    await pingStart();

    const run = await weeklyPushRepo.getRunById(runId);
    if (!run) {
      console.error(`[weeklyPush.worker] run ${runId} not found`);
      await pingFail(`run ${runId} not found`);
      continue;
    }
    if (run.status === "cancelled") continue;

    try {
      await weeklyPushRepo.updateRun(runId, {
        status: "preparing",
        startedAt: new Date(),
      });

      const recipients = await weeklyPushRepo.listRecipientsByRun(runId);

      let timedOut = false;
      let waitedMs = 0;
      let maxWaitMs = 0;

      if (run.dryRun) {
        // Dry-run: recipients were inserted as "skipped" by the
        // service, so there's nothing to send. Just produce the report
        // and push the summary so we exercise the full pipeline.
        console.log(
          `[weeklyPush.worker] DRY-RUN runId=${runId} skipping ${recipients.length} recipients`,
        );
      } else {
        await weeklyPushRepo.updateRun(runId, { status: "sending" });
        // Wet-run: fan out one job per pending recipient.
        const pending = recipients.filter((r) => r.status === "pending");
        for (const r of pending) {
          await enqueueRecipientJob(runId, r.id);
        }
        maxWaitMs = computeOrchestratorMaxWaitMs(pending.length);
        const result = await waitForRecipientsToFinish(runId, maxWaitMs);
        timedOut = !result.pendingDrained;
        waitedMs = result.waitedMs;
        if (timedOut) {
          console.warn(
            `[weeklyPush.worker] orchestrator timeout runId=${runId} ` +
              `waitedMs=${waitedMs} maxWaitMs=${maxWaitMs} — recipients still pending`,
          );
        }
      }

      // Final status MUST account for pending rows. Never report success
      // (or partial_failed, which implies completion) while work remains
      // in flight; that would lie in the CSV/summary/Healthchecks ping.
      const counts = await weeklyPushRepo.countRecipientStatuses(runId);
      let finalStatus: "success" | "partial_success" | "failed";
      let runErrorMessage: string | null = null;

      const unsettled = counts.pending + counts.sending + counts.retryWait;
      if (unsettled > 0) {
        finalStatus = "failed";
        runErrorMessage =
          `orchestrator_timeout: ${unsettled}/${counts.total} ` +
          `recipient(s) still pending after ${waitedMs}ms ` +
          `(maxWaitMs=${maxWaitMs})`;
      } else if (counts.failed === 0) {
        finalStatus = "success";
      } else if (counts.success === 0 && counts.skipped === 0) {
        finalStatus = "failed";
      } else {
        finalStatus = "partial_success";
      }

      await weeklyPushRepo.updateRun(runId, {
        status: finalStatus,
        successCount: counts.success,
        failureCount: counts.failed,
        skippedCount: counts.skipped,
        totalCount: counts.total,
        completedAt: new Date(),
        errorMessage: runErrorMessage,
      });

      // Generate report + push summary AFTER the run row is in its
      // terminal state so observers see counts/status that match the DB.
      const reportPath = await generateAndStoreReport(runId);
      console.log(`[weeklyPush.worker] report ready at ${reportPath}`);

      const updated = await weeklyPushRepo.getRunById(runId);
      const allRecipients = await weeklyPushRepo.listRecipientsByRun(runId);
      if (updated) {
        await pushRunSummary({ run: updated, recipients: allRecipients });
      }

      // Watchdog policy: any failed recipient (or pending after timeout)
      // should fire the alert. Only a clean run pings success — partial
      // failures are operationally significant and must be surfaced via
      // Healthchecks so on-call sees them.
      if (finalStatus === "success") {
        await pingSuccess(
          `runId=${runId} success=${counts.success} skip=${counts.skipped}`,
        );
      } else {
        await pingFail(
          runErrorMessage ??
            `runId=${runId} status=${finalStatus} ` +
              `success=${counts.success} fail=${counts.failed} skip=${counts.skipped}`,
        );
      }
    } catch (err) {
      console.error(
        `[weeklyPush.worker] orchestrator error runId=${runId}:`,
        err,
      );
      await weeklyPushRepo.updateRun(runId, {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await pingFail(err);
    }
  }
}

/**
 * Recipient handler — `includeMetadata: true` so we can read
 * `job.retrycount` and decide whether to re-throw (let pg-boss
 * retry per its `retryLimit/retryDelay/retryBackoff` policy) or
 * mark the recipient as final-failed.
 *
 * Status semantics during retries:
 *   - success                → status='success', attemptCount=N+1
 *   - failure, retries left  → status='pending' (pg-boss will redrive),
 *                               attemptCount/errorCode updated, THROW
 *   - failure, final attempt → status='failed', no throw
 *   - hard input error (no LINE id / bad payload) → status='failed' immediately,
 *     no throw — these would never succeed on retry
 *
 * pg-boss exposes the metadata field as `retryCount` (camelCase) on
 * the TS surface even though the underlying column is `retrycount`.
 */
async function handleRecipientJob(
  jobs: PgBoss.JobWithMetadata<WeeklyPushRecipientJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const { runId, recipientId } = job.data;
    const attemptNumber = (job.retryCount ?? 0) + 1;
    const isFinalAttempt = (job.retryCount ?? 0) >= RECIPIENT_RETRY_LIMIT;

    const recipient = await weeklyPushRepo.getRecipientById(recipientId);
    if (!recipient) {
      console.warn(
        `[weeklyPush.worker] recipient ${recipientId} not found for run ${runId}`,
      );
      continue;
    }
    // Only `pending` (incl. mid-retry) is actionable. Anything else means
    // a previous attempt already settled the row — idempotent skip so a
    // pg-boss redelivery doesn't double-send a successful message.
    if (!["pending", "retry_wait", "sending"].includes(recipient.status)) {
      continue;
    }

    // Hard input errors — never retried, no throw.
    if (!recipient.lineUserId) {
      await weeklyPushRepo.updateRecipient(recipientId, {
        status: "failed",
        attemptCount: attemptNumber,
        errorCode: "no_line_id",
        errorMessage: "recipient has no LINE user id",
      });
      continue;
    }
    const payload = readRecipientPayload(recipient.payloadJson);
    if (!payload) {
      await weeklyPushRepo.updateRecipient(recipientId, {
        status: "failed",
        attemptCount: attemptNumber,
        errorCode: "missing_payload",
        errorMessage: "recipient payload is missing or malformed",
      });
      continue;
    }

    await weeklyPushRepo.updateRecipient(recipientId, {
      status: "sending",
      attemptCount: attemptNumber,
      startedAt: new Date(),
    });

    const result = await sendTextMessage(
      recipient.lineUserId,
      payload.message,
      recipient.lineRetryKey,
    );

    if (result.ok) {
      await weeklyPushRepo.updateRecipient(recipientId, {
        status: "success",
        attemptCount: attemptNumber,
        sentAt: new Date(),
        completedAt: new Date(),
        lineResponseCode: result.status,
        errorCode: null,
        errorMessage: null,
      });
      continue;
    }

    // Task #32: a LINE 4xx (other than 429 rate-limit) will not change
    // on retry — invalid `to`, blocked user, expired token, etc. Treat
    // it as a hard final failure regardless of attempt number to avoid
    // burning the full retry budget on a guaranteed-failure call.
    const isHardClientError =
      result.errorCode === "http_4xx" && result.status !== 429;

    if (isFinalAttempt || isHardClientError) {
      await weeklyPushRepo.updateRecipient(recipientId, {
        status: "failed",
        attemptCount: attemptNumber,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        completedAt: new Date(),
        lineResponseCode: result.status,
      });
      // Don't throw — accept the failure as final so pg-boss marks the job complete.
      continue;
    }

    // Transient failure — keep status='pending', persist the latest error
    // for visibility, and THROW so pg-boss applies its retry policy.
    await weeklyPushRepo.updateRecipient(recipientId, {
      status: "retry_wait",
      attemptCount: attemptNumber,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      lineResponseCode: result.status,
      nextRetryAt: new Date(
        Date.now() + RECIPIENT_RETRY_DELAY_SECONDS * 1_000 * 2 ** (attemptNumber - 1),
      ),
    });
    throw new Error(
      `recipient ${recipientId} send failed (attempt ${attemptNumber}/${
        RECIPIENT_RETRY_LIMIT + 1
      }): ${result.errorCode ?? "unknown"} ${result.errorMessage ?? ""}`,
    );
  }
}

async function handleReportJob(
  jobs: PgBoss.Job<WeeklyPushReportJobData>[],
): Promise<void> {
  for (const job of jobs) {
    const { runId } = job.data;
    try {
      await generateAndStoreReport(runId);
    } catch (err) {
      console.error(
        `[weeklyPush.worker] report-job error runId=${runId}:`,
        err,
      );
    }
  }
}

/**
 * Boots pg-boss (idempotently), creates the three queues, and binds
 * the worker handlers. Safe to call multiple times — the second call
 * is a no-op.
 */
export async function startWeeklyPushWorkers(): Promise<void> {
  if (workersRegistered) return;
  await startBoss();
  const boss = getBoss();

  // pg-boss v10 requires the queue to exist before send/work.
  await boss.createQueue(queues.weeklyPush);
  await boss.createQueue(queues.weeklyPushRecipient);
  await boss.createQueue(queues.weeklyPushReport);

  await boss.work<WeeklyPushJobData>(
    queues.weeklyPush,
    { batchSize: 1 },
    handleWeeklyPushJob,
  );
  await boss.work<WeeklyPushRecipientJobData>(
    queues.weeklyPushRecipient,
    { batchSize: 1, includeMetadata: true },
    handleRecipientJob,
  );
  await boss.work<WeeklyPushReportJobData>(
    queues.weeklyPushReport,
    { batchSize: 1 },
    handleReportJob,
  );

  workersRegistered = true;
  console.log("[weeklyPush.worker] handlers registered");
}
