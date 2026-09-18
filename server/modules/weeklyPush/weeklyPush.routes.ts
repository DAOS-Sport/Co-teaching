/**
 * Admin REST endpoints for the weekly push pipeline (Task #23).
 *
 * All five endpoints are gated by `requireAdminPassword`. Per the
 * Task #22 architecture rules, this file does NO direct DB access —
 * it parses requests, calls the service / repository, and serializes
 * the response.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAdminPassword } from "../../shared/auth/adminPassword";
import { weeklyPushRepo } from "./weeklyPush.repository";
import {
  enqueueWeeklyPush,
  retryFailedRecipients,
} from "./weeklyPush.service";
import {
  reportExists,
  streamReport,
} from "../../infra/files/reportStorage";
import { renderXlsx } from "./weeklyPush.report";
import { featureFlags } from "../../config/featureFlags";
import { areWeeklyPushWorkersReady } from "./weeklyPush.worker";
import { reconcileWeeklyPushRun } from "./weeklyPush.reconcile";

const enqueueBodySchema = z.object({
  weekStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "weekStartDate must be YYYY-MM-DD")
    .optional(),
  weekEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "weekEndDate must be YYYY-MM-DD")
    .optional(),
  dryRun: z.boolean().optional(),
});

function pickPositiveInt(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function registerWeeklyPushRoutes(app: Express): void {
  // POST /api/admin/weekly-push/enqueue
  app.post(
    "/api/admin/weekly-push/enqueue",
    requireAdminPassword,
    async (req: Request, res: Response) => {
      const parsed = enqueueBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          message: "請求格式錯誤",
          issues: parsed.error.issues,
        });
      }
      const { weekStartDate, weekEndDate, dryRun } = parsed.data;
      if ((weekStartDate && !weekEndDate) || (!weekStartDate && weekEndDate)) {
        return res
          .status(400)
          .json({ message: "weekStartDate / weekEndDate 必須一起提供" });
      }
      try {
        if (dryRun !== true && (
          !featureFlags.enableWeeklyPushQueue ||
          !featureFlags.enableWeeklyPushWorker ||
          !areWeeklyPushWorkersReady()
        )) {
          return res.status(503).json({
            message: "週推播 worker 尚未就緒，已禁止正式發送",
          });
        }
        const result = await enqueueWeeklyPush({
          weekStartDate,
          weekEndDate,
          dryRun: dryRun === true,
          triggerSource: "manual",
        });
        return res.json({
          runId: result.run.id,
          reused: result.reused,
          recipientsCreated: result.recipientsCreated,
          run: result.run,
        });
      } catch (err) {
        console.error("[weeklyPush.routes] enqueue error", err);
        return res.status(500).json({
          message: "週推播排程失敗",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get(
    "/api/admin/weekly-push/readiness",
    requireAdminPassword,
    (_req, res) => {
      const ready = featureFlags.enableWeeklyPushQueue &&
        featureFlags.enableWeeklyPushWorker && areWeeklyPushWorkersReady();
      return res.status(ready ? 200 : 503).json({ ready });
    },
  );

  app.post(
    "/api/admin/weekly-push/runs/:runId/reconcile",
    requireAdminPassword,
    async (req, res) => {
      try {
        const run = await reconcileWeeklyPushRun(req.params.runId);
        if (!run) return res.status(404).json({ message: "找不到週推播紀錄" });
        return res.json({ run });
      } catch (err) {
        return res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/admin/weekly-push/runs/:runId/cancel",
    requireAdminPassword,
    async (req, res) => {
      const run = await weeklyPushRepo.getRunById(req.params.runId);
      if (!run) return res.status(404).json({ message: "找不到週推播紀錄" });
      if (["success", "partial_success", "failed", "cancelled"].includes(run.status)) {
        return res.status(409).json({ message: "此推播已結束，無法取消" });
      }
      const cancelledRecipients = await weeklyPushRepo.cancelUnsentRecipients(run.id);
      const updated = await weeklyPushRepo.updateRun(run.id, {
        status: "cancelled",
        completedAt: new Date(),
      });
      return res.json({ run: updated, cancelledRecipients });
    },
  );

  // GET /api/admin/weekly-push/runs?limit=
  app.get(
    "/api/admin/weekly-push/runs",
    requireAdminPassword,
    async (req: Request, res: Response) => {
      const limit = pickPositiveInt(req.query.limit, 50, 200);
      try {
        const runs = await weeklyPushRepo.listRuns(limit);
        return res.json({ runs });
      } catch (err) {
        console.error("[weeklyPush.routes] listRuns error", err);
        return res.status(500).json({ message: "讀取週推播紀錄失敗" });
      }
    },
  );

  // GET /api/admin/weekly-push/runs/:runId
  app.get(
    "/api/admin/weekly-push/runs/:runId",
    requireAdminPassword,
    async (req: Request, res: Response) => {
      const { runId } = req.params;
      try {
        const run = await weeklyPushRepo.getRunById(runId);
        if (!run) return res.status(404).json({ message: "找不到週推播紀錄" });
        const recipients = await weeklyPushRepo.listRecipientsByRun(runId);
        return res.json({ run, recipients });
      } catch (err) {
        console.error("[weeklyPush.routes] getRun error", err);
        return res.status(500).json({ message: "讀取週推播紀錄失敗" });
      }
    },
  );

  // GET /api/admin/weekly-push/runs/:runId/report?format=csv|xlsx
  app.get(
    "/api/admin/weekly-push/runs/:runId/report",
    requireAdminPassword,
    async (req: Request, res: Response) => {
      const { runId } = req.params;
      const fmt = req.query.format === "xlsx" ? "xlsx" : "csv";
      try {
        const run = await weeklyPushRepo.getRunById(runId);
        if (!run) return res.status(404).json({ message: "找不到週推播紀錄" });

        if (fmt === "xlsx") {
          // XLSX is generated on-demand from DB data (no extra storage needed)
          const recipients = await weeklyPushRepo.listRecipientsByRun(runId);
          const buf = await renderXlsx(run, recipients);
          res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          );
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="weekly-push-${runId}.xlsx"`,
          );
          return res.end(buf);
        }

        // CSV — serve the stored file
        if (!run.reportPath || !(await reportExists(run.reportPath))) {
          return res
            .status(404)
            .json({ message: "報表尚未產生或已被清除" });
        }
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="weekly-push-${runId}.csv"`,
        );
        await streamReport(run.reportPath, res, "csv");
        return;
      } catch (err) {
        console.error("[weeklyPush.routes] report error", err);
        return res.status(500).json({ message: "下載報表失敗" });
      }
    },
  );

  // POST /api/admin/weekly-push/runs/:runId/retry-failed
  app.post(
    "/api/admin/weekly-push/runs/:runId/retry-failed",
    requireAdminPassword,
    async (req: Request, res: Response) => {
      const { runId } = req.params;
      try {
        const result = await retryFailedRecipients(runId);
        return res.json({
          newRunId: result.run.id,
          recipientsCreated: result.recipientsCreated,
          run: result.run,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          return res.status(404).json({ message: msg });
        }
        if (msg.includes("no failed recipients")) {
          return res.status(400).json({ message: "此次推播沒有失敗的收件人" });
        }
        console.error("[weeklyPush.routes] retry error", err);
        return res
          .status(500)
          .json({ message: "重新推播失敗", error: msg });
      }
    },
  );
}
