import cron from "node-cron";
import { storage } from "./storage";
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

async function syncCoaches(): Promise<SyncResult["coaches"]> {
  // Sequential on purpose: Ragic answers bursts with empty 200 bodies.
  const allRecords = await fetchRagicRecords(RAGIC_COACH_API_URL);
  const personalInfo = await fetchPersonalInfo();

  const seen = new Set<string>();
  const activeCoaches: { name: string; phone: string | null; email: string | null }[] = [];
  for (const r of allRecords) {
    const name = field(r, "姓名");
    if (!name || EXCLUDED_NAMES.has(name) || !isCoachRole(r)) continue;
    if (seen.has(name)) {
      console.warn(`[Ragic] duplicate coach row in Ragic for "${name}" — using the first`);
      continue;
    }
    seen.add(name);
    activeCoaches.push({ name, phone: field(r, "手機") || null, email: field(r, "E-mail") || null });
  }
  if (allRecords.length > 0 && activeCoaches.length === 0) {
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
        } else {
          console.error(`[Ragic] failed to create "${coach.name}":`, errMessage(err));
        }
      }
      continue;
    }

    if (lineId && !current.lineId) {
      const owner = byLineId.get(lineId);
      if (owner && owner.id !== current.id) {
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
      }
    }
  }

  if (added > 0) console.log(`[Ragic] added ${added} new coaches`);
  if (lineIdsSynced > 0) console.log(`[Ragic] synced ${lineIdsSynced} LINE IDs`);
  if (employeeIdsSynced > 0) console.log(`[Ragic] synced ${employeeIdsSynced} employee IDs`);

  return { added, total: activeCoaches.length, lineIdsSynced, employeeIdsSynced };
}

export async function syncRagicAll(): Promise<SyncResult | null> {
  if (isSyncing) {
    return lastSyncResult;
  }

  isSyncing = true;

  try {
    const venues = await syncVenues();
    const coaches = await syncCoaches();
    const result: SyncResult = { venues, coaches };

    lastSyncTime = new Date().toISOString();
    lastSyncResult = result;
    lastError = null;

    console.log(
      `[Ragic] sync completed: ${venues.total} departments (${venues.added.length} new), ` +
        `${coaches.total} active coaches (${coaches.added} new, ${coaches.lineIdsSynced} LINE IDs synced)`,
    );
    return result;
  } catch (error) {
    lastError = { at: new Date().toISOString(), message: errMessage(error) };
    console.error("[Ragic] sync failed:", lastError.message);
    throw error;
  } finally {
    isSyncing = false;
  }
}

function scheduleBootRetry(attempt: number) {
  if (attempt >= BOOT_RETRY_DELAYS_MS.length) return;
  const delay = BOOT_RETRY_DELAYS_MS[attempt];
  console.warn(`[Ragic] boot sync failed — retry #${attempt + 1} in ${delay / 60_000} min`);
  setTimeout(() => {
    console.log(`[Ragic] boot retry #${attempt + 1} starting…`);
    syncRagicAll().catch((err) => {
      console.error(`[Ragic] boot retry #${attempt + 1} failed:`, errMessage(err));
      scheduleBootRetry(attempt + 1);
    });
  }, delay);
}

export function setupRagicSyncCron() {
  setTimeout(() => {
    console.log("[Ragic] boot sync starting");
    syncRagicAll().catch((err) => {
      console.error("[Ragic] boot sync failed:", errMessage(err));
      scheduleBootRetry(0);
    });
  }, BOOT_SYNC_DELAY_MS);

  // Taiwan has no DST, so 03:00 Asia/Taipei is the same instant as the
  // old "0 19 * * *" in server-local UTC — just written the way it reads.
  cron.schedule(
    "0 3 * * *",
    () => {
      console.log("[Ragic] daily sync triggered (03:00 Asia/Taipei)");
      syncRagicAll().catch((err) => {
        console.error("[Ragic] scheduled sync failed:", errMessage(err));
      });
    },
    { timezone: "Asia/Taipei" },
  );

  console.log(`[Ragic] daily sync scheduled 03:00 Asia/Taipei; boot sync in ${BOOT_SYNC_DELAY_MS / 1000}s`);
}
