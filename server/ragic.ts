import cron from "node-cron";
import { eq } from "drizzle-orm";
import { storage } from "./storage";
import { db, pool } from "./db";
import type { PoolClient } from "@neondatabase/serverless";
import { ragicSyncItems, ragicSyncRuns } from "@shared/schema";
import { recordAppLog } from "./shared/appLog";
import { fetchWithTimeout } from "./shared/http/fetchWithTimeout";
import {
  type RagicRecord,
  decideVenue,
  field,
  indexCoachUsersByLineId,
  indexCoachUsersByName,
  isCoachRole,
  normalizeLineId,
  parseRagicBody,
  runStatusFor,
  splitDuplicateNames,
  type RagicRunStatus,
} from "./ragic.logic";

const RAGIC_DEPT_API_URL = "https://ap7.ragic.com/xinsheng/ragicforms4/7";
const RAGIC_COACH_API_URL = "https://ap7.ragic.com/xinsheng/general-information/23";
const RAGIC_EMPLOYEE_API_URL = "https://ap7.ragic.com/xinsheng/ragicforms4/20004";

const VENUE_COLORS = ["blue", "green", "purple", "yellow", "orange", "teal", "red", "pink"];

const EXCLUDED_NAMES: ReadonlySet<string> = new Set(["(測試帳號)教練"]);

// The boot sync used to fire the instant routes were registered — three
// Ragic exports plus DB writes while the deployment healthcheck was
// hammering "/" on a freshly restarted VM. Give the process time to settle.
const BOOT_SYNC_DELAY_MS = 45_000;
const BOOT_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000]; // 5 min, 15 min

interface SyncResult {
  venues: { added: string[]; updated: string[]; total: number };
  coaches: { added: number; total: number; lineIdsSynced: number; employeeIdsSynced: number };
}

let lastSyncTime: string | null = null;
let lastSyncResult: SyncResult | null = null;
let lastError: { at: string; message: string } | null = null;
let isSyncing = false;

export function getRagicSyncStatus() {
  return { lastSyncTime, lastSyncResult, isSyncing, lastError };
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export type SyncTrigger = "schedule" | "manual" | "startup";

interface SyncFailure {
  kind: "coach" | "venue";
  sourceId: string;
  code: string;
  message: string;
}

interface RunOutcome {
  status: RagicRunStatus;
  total: number;
  failures: SyncFailure[];
  errorCode?: string | null;
}

interface RagicRunStore {
  start(trigger: SyncTrigger): Promise<string | null>;
  finish(runId: string | null, outcome: RunOutcome): Promise<void>;
}

/** Persists each run and its failed items; bookkeeping errors never stop a sync. */
const dbRunStore: RagicRunStore = {
  async start(trigger) {
    try {
      const [run] = await db.insert(ragicSyncRuns).values({ trigger, status: "running" }).returning({ id: ragicSyncRuns.id });
      return run.id;
    } catch (error) {
      console.error("[Ragic] could not record sync start:", (error as { code?: string })?.code ?? "error");
      return null;
    }
  },
  async finish(runId, outcome) {
    if (!runId) return;
    try {
      await db
        .update(ragicSyncRuns)
        .set({
          status: outcome.status,
          finishedAt: new Date(),
          totalCount: outcome.total,
          successCount: Math.max(outcome.total - outcome.failures.length, 0),
          failureCount: outcome.failures.length,
          errorCode: outcome.errorCode ?? null,
        })
        .where(eq(ragicSyncRuns.id, runId));
      if (outcome.failures.length > 0) {
        await db.insert(ragicSyncItems).values(
          outcome.failures.map((failure) => ({
            runId,
            kind: failure.kind,
            sourceId: failure.sourceId,
            status: "failed",
            errorCode: failure.code,
            errorMessage: failure.message,
          })),
        );
      }
    } catch (error) {
      console.error("[Ragic] could not record sync result:", (error as { code?: string })?.code ?? "error");
    }
  },
};

type SyncLock = { release: () => Promise<void> };
const NO_LOCK: SyncLock = { release: async () => {} };
// Shared by every instance, so only one of them syncs at a time.
const RAGIC_SYNC_LOCK_KEY = 7_310_021;

/** null = another instance is syncing. Lock trouble falls back to syncing unlocked. */
const dbSyncLock = async (): Promise<SyncLock | null> => {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return NO_LOCK;
  }
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [RAGIC_SYNC_LOCK_KEY]);
    if (!rows[0]?.ok) {
      client.release();
      return null;
    }
    return {
      release: async () => {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [RAGIC_SYNC_LOCK_KEY]);
        } finally {
          client.release();
        }
      },
    };
  } catch {
    client.release();
    return NO_LOCK;
  }
};

let runStore: RagicRunStore = dbRunStore;
let acquireSyncLock: () => Promise<SyncLock | null> = dbSyncLock;

export function setRagicRunStoreForTest(store: RagicRunStore): void {
  runStore = store;
}

export function setRagicSyncLockForTest(lock: () => Promise<SyncLock | null>): void {
  acquireSyncLock = lock;
}

/** Stored and shown instead of the raw error, which can carry Ragic URLs or names. */
function ragicErrorCode(error: unknown): string {
  const message = errMessage(error);
  if (message.includes("RAGIC_API_KEY is not configured")) return "RAGIC_NOT_CONFIGURED";
  if (message.startsWith("Ragic API failed")) return "RAGIC_FETCH_FAILED";
  return "RAGIC_SYNC_EXCEPTION";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Returns true when an error from Drizzle/Neon indicates a PostgreSQL
 * unique-constraint violation (code 23505), regardless of how deeply the
 * driver has nested the original PG error.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  if (e.code === "23505" || e.cause?.code === "23505") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return msg.includes("unique") || msg.includes("duplicate key");
}

async function fetchRagicRecords(
  apiUrl: string,
  limit = 500,
  { maxRetries = 2, retryDelayMs = 4_000 }: { maxRetries?: number; retryDelayMs?: number } = {},
): Promise<RagicRecord[]> {
  const apiKey = process.env.RAGIC_API_KEY;
  if (!apiKey) {
    throw new Error("RAGIC_API_KEY is not configured");
  }

  const url = `${apiUrl}?api&APIKey=${apiKey}&limit=${limit}`;
  let lastMessage = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.warn(`[Ragic] ${apiUrl}: ${lastMessage} — retry ${attempt}/${maxRetries} in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }

    // Task #32: Ragic exports can take a while when `limit` is in the
    // hundreds, so allow up to 20s before aborting (vs the default 8s).
    const response = await fetchWithTimeout(url, { timeoutMs: 20_000 });

    if (!response.ok) {
      lastMessage = `HTTP ${response.status} ${response.errorCode ?? ""} ${response.errorMessage ?? ""}`.trim();
      // A 4xx other than 429 will not change on retry.
      if (response.errorCode === "http_4xx" && response.status !== 429) break;
      continue;
    }

    const parsed = parseRagicBody(response.body);
    if (parsed.ok) return parsed.records;
    lastMessage = `${parsed.kind}: ${parsed.message}`;
    // Ragic's own error envelope (bad key, no access right) is final —
    // retrying cannot fix it, and it must not be mistaken for "no rows".
    if (parsed.kind === "api_error") break;
  }

  throw new Error(`Ragic API failed for ${apiUrl}: ${lastMessage}`);
}

async function syncVenues(): Promise<SyncResult["venues"]> {
  const departments = await fetchRagicRecords(RAGIC_DEPT_API_URL);
  const existingVenues = await storage.getVenues();
  const existingNames = new Set(existingVenues.map((v) => v.name));
  const existingInfos = new Map((await storage.getAllVenueInfos()).map((info) => [info.venueName, info]));

  const added: string[] = [];
  const updated: string[] = [];
  const aliases: string[] = [];
  let colorIndex = existingVenues.length;
  let named = 0;

  for (const dept of departments) {
    const name = field(dept, "部門名稱");
    if (name) named++;
    const decision = decideVenue({ name, operationType: field(dept, "營運性質") }, existingNames);
    if (decision.action === "skip") {
      if (decision.reason === "labor-alias") aliases.push(name);
      continue;
    }

    if (decision.action === "create") {
      const color = VENUE_COLORS[colorIndex % VENUE_COLORS.length];
      await storage.createVenue(name, color);
      added.push(name);
      existingNames.add(name);
      colorIndex++;
      console.log(`[Ragic] added venue "${name}"`);
    }

    const googleMap = field(dept, "google map");
    if (!googleMap) continue;
    const info = existingInfos.get(name);
    if (!info) {
      await storage.upsertVenueInfo(name, null, null, googleMap);
      updated.push(name);
      console.log(`[Ragic] added map URL for "${name}"`);
    } else if (!info.mapUrl) {
      await storage.upsertVenueInfo(name, info.videoUrl, info.description, googleMap);
      updated.push(name);
      console.log(`[Ragic] filled in map URL for "${name}"`);
    }
  }

  if (aliases.length > 0) {
    console.log(`[Ragic] skipped labour-contract aliases of existing venues: ${aliases.join(", ")}`);
  }
  return { added, updated, total: named };
}

interface PersonalInfo {
  lineId: string | null;
  employeeId: string | null;
}

async function fetchPersonalInfo(): Promise<Map<string, PersonalInfo>> {
  const records = await fetchRagicRecords(RAGIC_EMPLOYEE_API_URL);
  const infoMap = new Map<string, PersonalInfo>();
  for (const r of records) {
    const name = field(r, "姓名");
    if (!name) continue;
    infoMap.set(name, {
      lineId: normalizeLineId(field(r, "個人LINE ID")),
      employeeId: field(r, "員工編號") || null,
    });
  }
  const values = Array.from(infoMap.values());
  console.log(
    `[Ragic] personal info: ${values.filter((v) => v.lineId).length} LINE IDs, ` +
      `${values.filter((v) => v.employeeId).length} employee IDs`,
  );
  return infoMap;
}

async function syncCoaches(failures: SyncFailure[]): Promise<SyncResult["coaches"] & { considered: number }> {
  // Sequential on purpose: Ragic answers bursts with empty 200 bodies.
  const allRecords = await fetchRagicRecords(RAGIC_COACH_API_URL);
  const personalInfo = await fetchPersonalInfo();

  const candidates = allRecords.filter((r) => {
    const name = field(r, "姓名");
    return !!name && !EXCLUDED_NAMES.has(name) && isCoachRole(r);
  });
  // Two people with one name cannot be told apart: sync neither, report both.
  const { unique, duplicates } = splitDuplicateNames(candidates, (r) => field(r, "姓名"));
  for (const r of duplicates) {
    failures.push({
      kind: "coach",
      sourceId: String(r._ragicId),
      code: "DUPLICATE_NAME_IN_RAGIC",
      message: `Ragic 有多筆同名「${field(r, "姓名")}」，無法確定是哪一位，未同步`,
    });
  }
  const activeCoaches = unique.map((r) => ({
    name: field(r, "姓名"),
    ragicId: String(r._ragicId),
    phone: field(r, "手機") || null,
    email: field(r, "E-mail") || null,
  }));
  if (allRecords.length > 0 && candidates.length === 0) {
    console.warn(
      `[Ragic] ${allRecords.length} coach rows fetched but none had 姓名 + 教練 職務 — have the sheet's field names changed?`,
    );
  }

  const existing = await storage.getAllCoachUsers();
  const byName = indexCoachUsersByName(existing);
  const byLineId = indexCoachUsersByLineId(existing);

  let added = 0;
  let lineIdsSynced = 0;
  let employeeIdsSynced = 0;

  const fail = (coach: { name: string; ragicId: string }, code: string, message: string) =>
    failures.push({ kind: "coach", sourceId: coach.ragicId, code, message: `「${coach.name}」${message}` });

  for (const coach of activeCoaches) {
    const info = personalInfo.get(coach.name);
    const lineId = info?.lineId ?? null;
    const employeeId = info?.employeeId ?? null;
    const current = byName.get(coach.name);

    if (!current) {
      // Never hand a LINE ID that another account already owns to a new
      // row — that is the unique violation the old sync kept logging.
      const owner = lineId ? byLineId.get(lineId) : undefined;
      if (owner) {
        // Expected (10/15 user decision): not a sync failure.
        console.warn(`[Ragic] "${coach.name}": LINE ID already bound to "${owner.name}" — creating without it`);
      }
      try {
        const created = await storage.createCoachUser({
          name: coach.name,
          phone: coach.phone,
          email: coach.email,
          status: "approved",
          role: "coach",
          lineId: owner ? null : lineId,
          linkedCoachName: coach.name,
          employeeId,
        });
        byName.set(coach.name, created);
        if (created.lineId) byLineId.set(created.lineId, created);
        added++;
        if (created.lineId) lineIdsSynced++;
        if (employeeId) employeeIdsSynced++;
        console.log(
          `[Ragic] added coach "${coach.name}"${created.lineId ? " with LINE ID" : ""}${employeeId ? ` (${employeeId})` : ""}`,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          console.warn(`[Ragic] skipped creating "${coach.name}": unique conflict (registered concurrently?)`);
          fail(coach, "CREATE_CONFLICT", "建立帳號時與既有資料衝突，未建立");
        } else {
          console.error(`[Ragic] failed to create "${coach.name}":`, errMessage(err));
          fail(coach, "CREATE_FAILED", "建立帳號失敗");
        }
      }
      continue;
    }

    if (lineId && !current.lineId) {
      const owner = byLineId.get(lineId);
      if (owner && owner.id !== current.id) {
        // Expected (10/15 user decision): not a sync failure.
        console.warn(`[Ragic] "${coach.name}": LINE ID already bound to "${owner.name}" — not re-binding`);
      } else {
        try {
          const updatedUser = await storage.updateCoachUserLineId(current.id, lineId);
          if (updatedUser) {
            byName.set(coach.name, updatedUser);
            byLineId.set(lineId, updatedUser);
            lineIdsSynced++;
            console.log(`[Ragic] synced LINE ID for "${coach.name}" (was empty)`);
          }
        } catch (err) {
          if (isUniqueViolation(err)) {
            console.warn(`[Ragic] skipped LINE ID for "${coach.name}": taken by another account`);
          } else {
            console.error(`[Ragic] failed to sync LINE ID for "${coach.name}":`, errMessage(err));
            fail(coach, "LINE_ID_UPDATE_FAILED", "的 LINE ID 寫入失敗");
          }
        }
      }
    }

    if (employeeId && !current.employeeId) {
      try {
        await storage.updateCoachEmployeeId(current.id, employeeId);
        employeeIdsSynced++;
        console.log(`[Ragic] synced employee ID for "${coach.name}": ${employeeId}`);
      } catch (err) {
        console.error(`[Ragic] failed to sync employee ID for "${coach.name}":`, errMessage(err));
        fail(coach, "EMPLOYEE_ID_UPDATE_FAILED", "的員工編號寫入失敗");
      }
    }
  }

  if (added > 0) console.log(`[Ragic] added ${added} new coaches`);
  if (lineIdsSynced > 0) console.log(`[Ragic] synced ${lineIdsSynced} LINE IDs`);
  if (employeeIdsSynced > 0) console.log(`[Ragic] synced ${employeeIdsSynced} employee IDs`);

  return { added, total: activeCoaches.length, lineIdsSynced, employeeIdsSynced, considered: candidates.length };
}

export async function syncRagicAll(trigger: SyncTrigger = "manual"): Promise<SyncResult | null> {
  if (isSyncing) {
    return lastSyncResult;
  }

  isSyncing = true;
  const lock = await acquireSyncLock();
  if (!lock) {
    isSyncing = false;
    console.log("[Ragic] another instance is syncing — skipped");
    recordAppLog({ level: "info", source: "ragic", code: "RAGIC_SYNC_SKIPPED_BUSY", message: "另一台正在同步，本次跳過", detail: { trigger } });
    return lastSyncResult;
  }

  const runId = await runStore.start(trigger);
  const failures: SyncFailure[] = [];
  let considered = 0;
  try {
    const venues = await syncVenues();
    const coachResult = await syncCoaches(failures);
    const { considered: coachRows, ...coaches } = coachResult;
    considered = coachRows;
    const result: SyncResult = { venues, coaches };
    const status = runStatusFor(failures.length, false);

    lastSyncTime = new Date().toISOString();
    lastSyncResult = result;
    // A partial run must not look like a clean success on the IT page.
    lastError = failures.length > 0 ? { at: lastSyncTime, message: `${failures.length} 筆同步失敗` } : null;
    await runStore.finish(runId, { status, total: considered, failures });
    recordAppLog({
      level: failures.length > 0 ? "error" : "info",
      source: "ragic",
      code: failures.length > 0 ? "RAGIC_SYNC_PARTIAL" : "RAGIC_SYNC_OK",
      message: failures.length > 0 ? `Ragic 同步部分失敗：${failures.length} 筆` : "Ragic 同步完成",
      detail: { trigger, runId, total: considered, failed: failures.length },
    });

    console.log(
      `[Ragic] sync ${status}: ${venues.total} departments (${venues.added.length} new), ` +
        `${coaches.total} active coaches (${coaches.added} new, ${coaches.lineIdsSynced} LINE IDs synced), ` +
        `${failures.length} failed`,
    );
    return result;
  } catch (error) {
    const errorCode = ragicErrorCode(error);
    lastError = { at: new Date().toISOString(), message: errMessage(error) };
    console.error("[Ragic] sync failed:", lastError.message);
    await runStore.finish(runId, { status: runStatusFor(failures.length, true), total: considered, failures, errorCode });
    recordAppLog({ level: "error", source: "ragic", code: errorCode, message: "Ragic 同步失敗", detail: { trigger, runId } });
    throw error;
  } finally {
    isSyncing = false;
    await lock.release().catch(() => {});
  }
}

function scheduleBootRetry(attempt: number) {
  if (attempt >= BOOT_RETRY_DELAYS_MS.length) return;
  const delay = BOOT_RETRY_DELAYS_MS[attempt];
  console.warn(`[Ragic] boot sync failed — retry #${attempt + 1} in ${delay / 60_000} min`);
  setTimeout(() => {
    console.log(`[Ragic] boot retry #${attempt + 1} starting…`);
    syncRagicAll("startup").catch((err) => {
      console.error(`[Ragic] boot retry #${attempt + 1} failed:`, errMessage(err));
      scheduleBootRetry(attempt + 1);
    });
  }, delay);
}

export function setupRagicSyncCron() {
  setTimeout(() => {
    console.log("[Ragic] boot sync starting");
    syncRagicAll("startup").catch((err) => {
      console.error("[Ragic] boot sync failed:", errMessage(err));
      scheduleBootRetry(0);
    });
  }, BOOT_SYNC_DELAY_MS);

  // Taiwan has no DST, so 03:00 Asia/Taipei is the same instant as the
  // old "0 19 * * *" in server-local UTC — just written the way it reads.
  startRagicDailySchedule();

  console.log(`[Ragic] daily sync scheduled 03:00 Asia/Taipei; boot sync in ${BOOT_SYNC_DELAY_MS / 1000}s`);
}

/** Explicit operational entry: preserves the daily job without boot-time writes. */
export function startRagicDailySchedule() {
  return cron.schedule(
    "0 3 * * *",
    () => {
      console.log("[Ragic] daily sync triggered (03:00 Asia/Taipei)");
      syncRagicAll("schedule").catch((err) => {
        console.error("[Ragic] scheduled sync failed:", errMessage(err));
      });
    },
    { timezone: "Asia/Taipei" },
  );

}
