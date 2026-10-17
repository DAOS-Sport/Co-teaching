import type { Express } from "express";
import { syncRagicAll, getRagicSyncStatus } from "../ragic";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { ADMIN_ACTOR, recordTriggerAudit, requestIdOf } from "../shared/audit";
import { externalWakeConfigured } from './notificationWake/wake-readiness';
import { enqueueExternalDateJob } from './notificationWake/wake-intake';

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
        if(externalWakeConfigured()) {
          const result=await enqueueExternalDateJob('ragic');await audit(result.queued?'已持久排入，尚未完成':'今日工作已完成，未建立新工作');
          return res.status(result.queued?202:200).json({...result,message:result.queued?'已排入；同步結果請至 IT 治理核對':'今日工作已完成；未建立新工作，結果請至 IT 治理核對'});
        }
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
        if(error instanceof Error&&error.message==='external_wake_date_job_requires_review')return res.status(409).json({code:'EXTERNAL_WAKE_DATE_JOB_REQUIRES_REVIEW',message:'此日期的工作已失敗或取消，尚未重新排入；請先至 IT 治理核對'});
        console.error("Manual Ragic sync error:", error);
        await audit("失敗");
        res.status(500).json({ message: "同步失敗", error: String(error) });
      }
    }
  );
}
