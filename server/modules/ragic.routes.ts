import type { Express } from "express";
import { syncRagicAll, getRagicSyncStatus } from "../ragic";
import { runDurableSync } from "./ragicSync.service";
import { requireAdminPassword } from "../shared/auth/adminPassword";
import { pool } from "../db";
import { MutationError } from "../shared/audit";
export function registerRagicRoutes(app: Express): void {
  app.get("/api/admin/ragic-status", requireAdminPassword, async (_req, res) => {
    try { res.json(await getRagicSyncStatus()); } catch { res.status(503).json({ message: "同步紀錄暫時無法讀取" }); }
  });
  app.get("/api/admin/ragic-runs/:runId/items", requireAdminPassword, async (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.runId)) return res.status(400).json({ message: "Invalid run id" });
    try { const r = await pool.query("SELECT kind,source_id,status,attempts,error_code,updated_at FROM ragic_sync_items WHERE run_id=$1 ORDER BY kind,source_id", [req.params.runId]); res.json(r.rows); }
    catch { res.status(503).json({ message: "同步明細暫時無法讀取" }); }
  });
  app.post("/api/admin/ragic-sync", requireAdminPassword, async (_req, res) => {
    try { const result = await syncRagicAll(); res.json({ success: result.status === "succeeded", ...result }); }
    catch (error) { res.status(error instanceof MutationError ? error.status : 500).json({ message: "同步失敗，請查看紀錄", code: error instanceof MutationError ? error.code : "SYNC_FAILED" }); }
  });
  app.post("/api/admin/ragic-runs/:runId/retry", requireAdminPassword, async (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.runId)) return res.status(400).json({ message: "Invalid run id" });
    try { const result = await runDurableSync(null, req.params.runId); res.json({ success: result.status === "succeeded", ...result }); }
    catch (error) { res.status(error instanceof MutationError ? error.status : 500).json({ code: error instanceof MutationError ? error.code : "SYNC_RETRY_FAILED" }); }
  });
}
