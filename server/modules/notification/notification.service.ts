import { notificationIdentity, sendDurableText } from "./delivery.service";
/**
 * Group-level summary notifications used by the weekly push (Task #23).
 *
 * The IT operations group always receives the run summary so we can
 * see counts and the report download link. The 協同課 group is opt-in
 * via `LINE_XIE_TONG_GROUP_ID` so we can verify the pipeline against
 * IT first without spamming staff.
 */
import { env } from "../../config/env";
import { lineGroups } from "../../config/lineGroups";
import type { WeeklyPushRecipient, WeeklyPushRun } from "@shared/schema";

interface SummaryParams {
  run: WeeklyPushRun;
  recipients: WeeklyPushRecipient[];
  /**
   * Public origin used to build the report download URL. Falls back
   * to `env.publicOrigin` when not provided so cron-triggered pushes
   * still produce a clickable link.
   */
  publicOrigin?: string;
}

function reportDownloadUrl(runId: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/admin/weekly-push/runs/${runId}/report`;
}

function formatSummaryMessage(
  run: WeeklyPushRun,
  recipients: WeeklyPushRecipient[],
  origin: string,
): string {
  const failed = recipients.filter((r) => r.status === "failed");
  const tag = run.dryRun ? "🧪 [DRY-RUN] " : "";
  const lines: string[] = [];
  lines.push(`${tag}📊 週推播總結`);
  lines.push(`區間: ${run.weekStartDate} ~ ${run.weekEndDate}`);
  lines.push(`觸發來源: ${run.triggerSource}`);
  lines.push(`狀態: ${run.status}`);
  lines.push("");
  lines.push(`收件人總數: ${run.totalCount}`);
  lines.push(`成功: ${run.successCount}`);
  lines.push(`失敗: ${run.failureCount}`);
  lines.push(`略過: ${run.skippedCount}`);
  // Surface any recipients still in 'pending' (e.g. orchestrator timeout)
  // so the LINE summary reflects the same reality the CSV does.
  const pending = recipients.filter((r) => r.status === "pending").length;
  if (pending > 0) {
    lines.push(`等待中: ${pending} (orchestrator timeout — 請重跑或手動 retry-failed)`);
  }
  if (run.errorMessage) {
    lines.push("");
    lines.push(`⚠️ ${run.errorMessage}`);
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push("❌ 失敗清單:");
    for (const f of failed.slice(0, 20)) {
      const reason = f.errorMessage || f.errorCode || "未知錯誤";
      lines.push(`  • ${f.recipientName}: ${reason}`);
    }
    if (failed.length > 20) {
      lines.push(`  ... 另有 ${failed.length - 20} 筆,請下載報表查看`);
    }
  }

  lines.push("");
  lines.push(`📥 報表: ${reportDownloadUrl(run.id, origin)}`);
  return lines.join("\n");
}

/**
 * Pushes the run summary to the configured groups. Missing group IDs
 * only produce a warn-level log so the worker keeps running. Returns
 * the per-group dispatch outcome for diagnostic logging.
 */
export async function pushRunSummary(params: SummaryParams) {
  if (params.run.dryRun) {
    return { itPushed: false, xiePushed: false, states: { it: "skipped", xie: "skipped" },
      status: "skipped", configuredCount: 0, resultVersion: null, skippedReason: "dry_run" } as const;
  }
  const origin = params.publicOrigin ?? env.publicOrigin;
  const text = formatSummaryMessage(params.run, params.recipients, origin);
  const resultVersion = notificationIdentity("weekly-summary-result", [params.run.status, params.run.totalCount, params.run.successCount,
    params.run.failureCount, params.run.skippedCount, params.recipients.map(r => [r.id, r.status, r.errorCode ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  type State = "accepted" | "unknown" | "failed" | "not_configured";
  const send = async (to: string | undefined | null, target: string): Promise<State> => {
    if (!to) return "not_configured";
    const result = await sendDurableText({ notificationId: notificationIdentity("weekly-summary", [params.run.id, target, resultVersion]), to, text, reuseSavedPayload: true });
    if (result.accepted) return "accepted";
    if (result.state === "not_configured") return "not_configured";
    return result.state === "failed" ? "failed" : "unknown";
  };
  const it = await send(lineGroups.itGroupId, "it");
  const xie = await send(lineGroups.xieTongGroupId, "xie");
  const configuredCount = Number(Boolean(lineGroups.itGroupId)) + Number(Boolean(lineGroups.xieTongGroupId));
  const configured = [it, xie].filter(state => state !== "not_configured");
  const status: State = configured.includes("failed") ? "failed" : configured.includes("unknown") ? "unknown"
    : configured.length === configuredCount && configuredCount > 0 ? "accepted" : "not_configured";
  return { itPushed: it === "accepted", xiePushed: xie === "accepted", states: { it, xie }, status, configuredCount, resultVersion };
}

export { formatSummaryMessage };
