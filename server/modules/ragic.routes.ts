import type { Express } from "express";
import { timingSafeEqual } from "node:crypto";
import { syncRagicAll, getRagicSyncStatus } from "../ragic";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { ADMIN_ACTOR, recordTriggerAudit, requestIdOf } from "../shared/audit";

function cronTokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerRagicRoutes(app: Express): void {
  // Daily sync, called by the Replit scheduled deployment at 03:00 Taipei.
  // Production runs on Autoscale and sleeps at night, so the in-process
  // 03:00 cron rarely fires; this request wakes the app and syncs.
  app.post("/api/internal/ragic-sync", async (req, res) => {
    const expected = process.env.RAGIC_CRON_TOKEN;
    if (!expected) return res.status(503).json({ message: "RAGIC_CRON_TOKEN 未設定" });
    if (!cronTokenMatches(req.get("x-cron-token"), expected)) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    try {
      const previousSync = getRagicSyncStatus().lastSyncTime;
      await syncRagicAll("schedule");
      const status = getRagicSyncStatus();
      if (status.lastSyncTime === previousSync) {
        return res.json({ status: "skipped", message: "另一個同步進行中，本次跳過" });
      }
      return res.json({ status: status.lastError ? "partial_failed" : "success", lastSyncTime: status.lastSyncTime });
    } catch {
      // Details are in the Ragic sync runs and the error log.
      return res.status(500).json({ status: "failed" });
    }
  });

  app.get(
    "/api/admin/ragic-status",
    requireAdminPassword,
    async (_req, res) => {
      res.json(getRagicSyncStatus());
    }
  );

  app.post(
    "/api/admin/ragic-sync",
    requireAdminPassword,
    async (req, res) => {
      // #3: Ragic itself cannot be rolled back; record the trigger with its
      // outcome. Per-row detail lives in the Ragic sync runs (#1).
      const audit = (result: string) =>
        recordTriggerAudit({
          actor: ADMIN_ACTOR,
          requestId: requestIdOf(req),
          action: "ragic.sync",
          entity: "ragic_sync",
          entityId: "manual",
          after: { result },
        });
      try {
        const previousSync = getRagicSyncStatus().lastSyncTime;
        const result = await syncRagicAll();
        const status = getRagicSyncStatus();
        // A sync already running here or on another instance returns the
        // previous result without running; say so instead of reusing it.
        await audit(
          status.lastSyncTime === previousSync
            ? "另一個同步進行中，本次跳過"
            : status.lastError
              ? "有失敗（見 Ragic 同步紀錄）"
              : "完成",
        );
        res.json({ success: true, ...result });
      } catch (error) {
        console.error("Manual Ragic sync error:", error);
        await audit("失敗");
        res.status(500).json({ message: "同步失敗", error: String(error) });
      }
    }
  );
}
