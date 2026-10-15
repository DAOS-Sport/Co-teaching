import type { Express } from "express";
import { syncRagicAll, getRagicSyncStatus } from "../ragic";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { ADMIN_ACTOR, recordTriggerAudit, requestIdOf } from "../shared/audit";

export function registerRagicRoutes(app: Express): void {
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
        const result = await syncRagicAll();
        await audit(getRagicSyncStatus().lastError ? "有失敗（見 Ragic 同步紀錄）" : "完成");
        res.json({ success: true, ...result });
      } catch (error) {
        console.error("Manual Ragic sync error:", error);
        await audit("失敗");
        res.status(500).json({ message: "同步失敗", error: String(error) });
      }
    }
  );
}
