/**
 * Pure, side-effect-free pieces of the Ragic sync so they can be unit
 * tested without a database or network. `server/ragic.ts` owns fetching,
 * DB writes, cron and status bookkeeping, and delegates every decision
 * that does not need I/O to this module.
 */

export interface RagicRecord {
  _ragicId: number;
  [key: string]: unknown;
}

export type RagicParse =
  | { ok: true; records: RagicRecord[] }
  | { ok: false; kind: "empty" | "malformed" | "api_error"; message: string };

/**
 * Ragic answers HTTP 200 for almost everything. A successful list call is
 * an object keyed by record id; a rejected call is an envelope such as
 * `{"status":"ERROR","msg":"This sheet is access right protected…"}`.
 * Running `Object.values()` over both shapes (what the sync used to do)
 * turns the envelope into "zero records" and the failure disappears.
 */
export function parseRagicBody(body: string): RagicParse {
  if (!body || body.trim() === "") {
    return { ok: false, kind: "empty", message: "empty response body" };
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      kind: "malformed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, kind: "malformed", message: "expected an object keyed by record id" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.status === "string" && !("_ragicId" in obj)) {
    const msg = typeof obj.msg === "string" ? obj.msg : "";
    return { ok: false, kind: "api_error", message: msg ? `${obj.status}: ${msg}` : obj.status };
  }
  return { ok: true, records: Object.values(obj).filter(isRagicRecord) };
}

function isRagicRecord(v: unknown): v is RagicRecord {
  return !!v && typeof v === "object" && !Array.isArray(v) && "_ragicId" in v;
}

/** Reads a Ragic text field; null / undefined / non-string become "". */
export function field(record: RagicRecord, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v.trim() : "";
}

// ─── Venues ────────────────────────────────────────────────────────────

/**
 * Departments that exist in Ragic but must never become a venue here.
 * Kept as a name blocklist because "營運性質" alone does not separate
 * teaching pools from other 勞務採購 contracts.
 */
export const EXCLUDED_VENUES: ReadonlySet<string> = new Set([
  "勞務-民生國中", "勞務-西湖國中", "勞務-明倫高中", "勞務-永吉國中", "勞務-陽明高中",
  "勞務-台灣科技大學", "國防醫學大學", "溪口國小", "百齡高中", "建成國中",
  "駿斯運動事業股份有限公司", "士東國小", "新竹科學園區", "新屋高中",
  "行銷事業處", "數位轉型發展處", "人力資源處", "營運管理處",
]);

const INTERNAL_OPERATION_TYPE = "內勤單位";
const LABOR_PREFIX = "勞務-";

export type VenueDecision =
  | { action: "create" }
  | { action: "exists" }
  | { action: "skip"; reason: "unnamed" | "excluded" | "internal" | "labor-alias" };

export function decideVenue(
  dept: { name: string; operationType: string },
  existingNames: ReadonlySet<string>,
): VenueDecision {
  const name = dept.name.trim();
  if (!name) return { action: "skip", reason: "unnamed" };
  if (EXCLUDED_VENUES.has(name)) return { action: "skip", reason: "excluded" };
  if (dept.operationType.trim() === INTERNAL_OPERATION_TYPE) {
    return { action: "skip", reason: "internal" };
  }
  if (existingNames.has(name)) return { action: "exists" };
  // Ragic lists the labour contract as "勞務-福林國小" while the venue here
  // is the seeded "福林國小". Creating a second venue for the same campus
  // is how the empty "勞務-福林國小" row got into the table.
  if (name.startsWith(LABOR_PREFIX) && existingNames.has(name.slice(LABOR_PREFIX.length))) {
    return { action: "skip", reason: "labor-alias" };
  }
  return { action: "create" };
}

// ─── Coaches ───────────────────────────────────────────────────────────

/** Structural subset of `CoachUser` this module needs; keeps it DB-free. */
export interface CoachLike {
  id: string;
  name: string;
  status: string;
  lineId: string | null;
  employeeId: string | null;
  createdAt: Date | null;
}

const STATUS_RANK: Record<string, number> = { approved: 0, pending: 1, rejected: 2 };

/**
 * Lower is better. Approved accounts win over pending over rejected; among
 * equals the one already holding a LINE ID wins; then the oldest.
 * `coach_users.name` is not unique and 21 names currently have one
 * approved + one rejected row — `new Map(users.map(...))` kept whichever
 * row happened to come last.
 */
export function compareCoachPriority(a: CoachLike, b: CoachLike): number {
  const s = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
  if (s !== 0) return s;
  const l = (a.lineId ? 0 : 1) - (b.lineId ? 0 : 1);
  if (l !== 0) return l;
  const ta = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const tb = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return ta - tb;
}

/** One canonical account per trimmed name (see `compareCoachPriority`). */
export function indexCoachUsersByName<T extends CoachLike>(users: readonly T[]): Map<string, T> {
  const byName = new Map<string, T>();
  for (const u of users) {
    const key = u.name.trim();
    if (!key) continue;
    const cur = byName.get(key);
    if (!cur || compareCoachPriority(u, cur) < 0) byName.set(key, u);
  }
  return byName;
}

/** LINE user id → account that already owns it (unique in the DB). */
export function indexCoachUsersByLineId<T extends CoachLike>(users: readonly T[]): Map<string, T> {
  const byLine = new Map<string, T>();
  for (const u of users) {
    if (u.lineId) byLine.set(u.lineId, u);
  }
  return byLine;
}

export function isCoachRole(record: RagicRecord): boolean {
  const job = record["應徵職務"];
  if (Array.isArray(job)) return job.some((j) => typeof j === "string" && j.includes("教練"));
  if (typeof job === "string") return job.includes("教練");
  return false;
}

/**
 * LINE user ids are "U" + 32 hex characters. Anything else in the
 * 個人LINE ID column (display names, partial pastes) must not reach the
 * unique `line_id` column.
 */
export function normalizeLineId(raw: string): string | null {
  const v = raw.trim();
  return /^U[0-9a-f]{32}$/i.test(v) ? v : null;
}
