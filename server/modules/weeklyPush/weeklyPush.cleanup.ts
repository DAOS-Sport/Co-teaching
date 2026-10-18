/**
 * 90-day report cleanup for the weekly push pipeline.
 *
 * Runs daily at 03:30 Asia/Taipei (gated by enableWeeklyPushQueue).
 * For each run whose report is older than 90 days:
 *   1. Deletes the underlying Object Storage object.
 *   2. Nulls out `weekly_push_runs.report_path` so the download
 *      endpoint correctly returns 404 instead of an error.
 */
import { weeklyPushRepo } from "./weeklyPush.repository";
import { deleteReport } from "../../infra/files/reportStorage";

const RETENTION_DAYS = 90;

export async function cleanupOldReports(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `[cleanup] Starting weekly-push report cleanup. Cutoff: ${cutoff.toISOString()}`,
  );

  const oldRuns = await weeklyPushRepo.listRunsWithExpiredReports(cutoff);
  if (oldRuns.length === 0) {
    console.log("[cleanup] No expired reports found.");
    return;
  }

  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;

  for (const run of oldRuns) {
    try {
      const existed = await deleteReport(run.reportPath!);
      if (existed) {
        deleted++;
      } else {
        alreadyGone++;
      }
      await weeklyPushRepo.updateRun(run.id, { reportPath: null });
    } catch (err) {
      console.error(
        `[cleanup] Failed to clean up report for run ${run.id}:`,
        err,
      );
      failed++;
    }
  }

  console.log(
    `[cleanup] Done. deleted=${deleted} alreadyGone=${alreadyGone} failed=${failed} total=${oldRuns.length}`,
  );

  if (failed > 0) throw new Error("weekly_push_report_cleanup_failed");
}

export async function setupReportCleanupCron() {
  const { configureNotificationSchedules } = await import("../../infra/queue/runtime");
  return configureNotificationSchedules({ enabled: true, kinds: ["cleanup"] });
}
