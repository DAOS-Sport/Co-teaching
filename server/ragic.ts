import cron from "node-cron";
import { storage } from "./storage";
import { fetchWithTimeout } from "./shared/http/fetchWithTimeout";
import { decideVenue, field, isCoachRole, normalizeLineId, parseRagicBody, type RagicRecord } from "./ragic.logic";
import { readDurableSyncStatus, runDurableSync, type SyncItem } from "./modules/ragicSync.service";
import { MutationError } from "./shared/audit";

export const getRagicSyncStatus = readDurableSyncStatus;
async function fetchRecords(sheet: string): Promise<RagicRecord[]> {
  const key = process.env.RAGIC_API_KEY;
  if (!key) throw new MutationError("RAGIC_NOT_CONFIGURED", 503);
  const response = await fetchWithTimeout(`https://ap7.ragic.com/xinsheng/${sheet}?api&limit=500&APIKey=${encodeURIComponent(key)}`, { timeoutMs: 20_000 });
  if (!response.ok) throw new MutationError(response.errorCode === "timeout" ? "RAGIC_TIMEOUT" : "RAGIC_HTTP_FAILED", 502);
  const parsed = parseRagicBody(response.body);
  if (!parsed.ok) throw new MutationError("RAGIC_INVALID_RESPONSE", 502);
  if (parsed.records.length >= 500) throw new MutationError("RAGIC_EXPORT_LIMIT_REACHED", 502);
  return parsed.records;
}
export async function syncRagicAll() {
  return runDurableSync(async () => {
    const [departments, coaches, existing] = await Promise.all([fetchRecords("ragicforms4/7"), fetchRecords("general-information/23"), storage.getVenues()]);
    const names = new Set(existing.map(v => v.name));
    const items: SyncItem[] = [];
    for (const record of departments) {
      const name = field(record, "部門名稱");
      if (decideVenue({ name, operationType: field(record, "營運性質") }, names).action === "skip") continue;
      items.push({ kind: "venue", sourceId: `ragicforms4/7:${record._ragicId}`, name, mapUrl: field(record, "google map") || null });
    }
    for (const record of coaches) {
      const name = field(record, "姓名");
      if (!name || !isCoachRole(record) || name === "(測試帳號)教練") continue;
      if (!Number.isInteger(record._ragicId)) throw new MutationError("INVALID_SOURCE_IDENTITY");
      items.push({ kind: "coach", sourceId: `general-information/23:${record._ragicId}`, name,
        phone: field(record, "手機") || null, email: field(record, "E-mail") || null,
        lineId: normalizeLineId(field(record, "個人LINE ID")), employeeId: field(record, "員工編號") || null });
    }
    return items;
  });
}
export function setupRagicSyncCron() {
  const run = () => syncRagicAll().catch(() => console.error("[Ragic] sync incomplete; inspect persisted run and item statuses"));
  setTimeout(run, 45_000);
  cron.schedule("0 3 * * *", run, { timezone: "Asia/Taipei" });
}
