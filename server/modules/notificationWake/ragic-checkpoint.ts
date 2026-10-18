import { decideVenue, field, isCoachRole, normalizeLineId, type RagicRecord } from "../../ragic.logic";

export type RagicCheckpointSource = "departments" | "coaches" | "employees";
export type RagicCheckpointPhase = "fetch_departments" | "fetch_coaches" | "fetch_employees" | "apply_departments" | "apply_coaches" | "complete";
export interface RagicCheckpointControl {
  signal: AbortSignal;
  deadlineMs: number;
  now?: () => number;
  shouldContinue?: () => boolean;
  /** Number of source items in a single transaction plus checkpoint; default one. */
  limit?: number;
}
export interface RagicCheckpointCounts {
  venuesConsidered: number;
  venuesAdded: number;
  venueMapsFilled: number;
  coachesConsidered: number;
  coachesAdded: number;
  lineIdsFilled: number;
  employeeIdsFilled: number;
  lineIdConflicts: number;
  ambiguous: number;
  skipped: number;
}
export interface RagicCheckpointFailure { kind: "coach" | "venue"; sourceId: string; code: string }
export interface RagicCheckpoint {
  version: 1;
  targetDate: string;
  phase: RagicCheckpointPhase;
  cursor: number;
  status: "running" | "success" | "partial_failed";
  /** Contains private source data. Store only in the protected existing job.data; never log or return over HTTP. */
  snapshots: Partial<Record<RagicCheckpointSource, RagicRecord[]>>;
  counts: RagicCheckpointCounts;
  failures: RagicCheckpointFailure[];
}
export interface RagicCheckpointCoach {
  id: string;
  name: string;
  lineId: string | null;
  employeeId: string | null;
}
export interface RagicCheckpointStorage {
  getVenues(): Promise<{ id: string; name: string; color?: string }[]>;
  getAllVenueInfos(): Promise<{ venueName: string; mapUrl: string | null; videoUrl: string | null; description: string | null }[]>;
  createVenue(name: string, color: string): Promise<unknown>;
  upsertVenueInfo(name: string, videoUrl: string | null, description: string | null, mapUrl: string | null): Promise<unknown>;
  getAllCoachUsers(): Promise<RagicCheckpointCoach[]>;
  createCoachUser(input: { name: string; phone: string | null; email: string | null; status: "approved"; role: "coach"; lineId: string | null; linkedCoachName: string; employeeId: string | null }): Promise<RagicCheckpointCoach>;
  updateCoachUserLineId(id: string, lineId: string): Promise<RagicCheckpointCoach | undefined>;
  updateCoachEmployeeId(id: string, employeeId: string): Promise<RagicCheckpointCoach | undefined>;
}
export interface RagicCheckpointDependencies {
  fetchSource(source: RagicCheckpointSource, control: RagicCheckpointControl): Promise<RagicRecord[]>;
  /** Must be the transaction-scoped storage facade. The caller owns fail-closed locking and atomic checkpoint persistence. */
  storage: RagicCheckpointStorage;
  excludedNames: ReadonlySet<string>;
  venueColors: readonly string[];
}

function validDate(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function createRagicCheckpoint(targetDate: string): RagicCheckpoint {
  if (!validDate(targetDate)) throw new Error("invalid_ragic_target_date");
  return { version: 1, targetDate, phase: "fetch_departments", cursor: 0, status: "running", snapshots: {},
    counts: { venuesConsidered: 0, venuesAdded: 0, venueMapsFilled: 0, coachesConsidered: 0, coachesAdded: 0,
      lineIdsFilled: 0, employeeIdsFilled: 0, lineIdConflicts: 0, ambiguous: 0, skipped: 0 }, failures: [] };
}

function active(control: RagicCheckpointControl): boolean {
  if (!control.signal || !Number.isFinite(control.deadlineMs)) throw new Error("invalid_ragic_step_control");
  return !control.signal.aborted && (control.now ?? Date.now)() < control.deadlineMs && control.shouldContinue?.() !== false;
}
function assertActive(control: RagicCheckpointControl): void {
  if (!active(control)) throw new Error("ragic_step_interrupted");
}

function validate(data: RagicCheckpoint): void {
  const phases: RagicCheckpointPhase[] = ["fetch_departments", "fetch_coaches", "fetch_employees", "apply_departments", "apply_coaches", "complete"];
  const index = phases.indexOf(data.phase);
  if (data.version !== 1 || !validDate(data.targetDate) || index < 0 || !Number.isInteger(data.cursor) || data.cursor < 0 || !data.snapshots || !data.counts || !Array.isArray(data.failures)) throw new Error("invalid_ragic_checkpoint");
  const expectedStatus = data.phase === "complete" ? (data.failures.length ? "partial_failed" : "success") : "running";
  if (data.status !== expectedStatus) throw new Error("invalid_ragic_checkpoint_status");
  const counterKeys: (keyof RagicCheckpointCounts)[] = ["venuesConsidered", "venuesAdded", "venueMapsFilled", "coachesConsidered", "coachesAdded", "lineIdsFilled", "employeeIdsFilled", "lineIdConflicts", "ambiguous", "skipped"];
  if (counterKeys.some(key => !Number.isInteger(data.counts[key]) || data.counts[key] < 0)) throw new Error("invalid_ragic_checkpoint_counters");
  const sources: RagicCheckpointSource[] = ["departments", "coaches", "employees"];
  for (let n = 0; n < sources.length; n++) {
    const records = data.snapshots[sources[n]];
    if (index > n && !Array.isArray(records)) throw new Error("ragic_snapshot_missing");
    if (records && records.length >= 500) throw new Error("ragic_source_completeness_unproven");
  }
  if (data.phase === "apply_departments" && data.cursor > data.snapshots.departments!.length) throw new Error("invalid_ragic_checkpoint_cursor");
  if (data.phase === "apply_coaches" && data.cursor > data.snapshots.coaches!.length) throw new Error("invalid_ragic_checkpoint_cursor");
}

async function applyDepartment(record: RagicRecord, data: RagicCheckpoint, dependencies: RagicCheckpointDependencies, control: RagicCheckpointControl): Promise<void> {
  const name = field(record, "部門名稱");
  if (name) data.counts.venuesConsidered++;
  assertActive(control);
  const venues = await dependencies.storage.getVenues();
  assertActive(control);
  const decision = decideVenue({ name, operationType: field(record, "營運性質") }, new Set(venues.map(venue => venue.name)));
  if (decision.action === "skip") { data.counts.skipped++; return; }
  if (decision.action === "create") {
    const color = dependencies.venueColors[venues.length % dependencies.venueColors.length];
    if (!color) throw new Error("ragic_venue_colors_not_configured");
    const created = await dependencies.storage.createVenue(name, color);
    if (!created) throw new Error("ragic_venue_create_unconfirmed");
    data.counts.venuesAdded++;
  }
  const mapUrl = field(record, "google map");
  if (!mapUrl) return;
  assertActive(control);
  const infos = await dependencies.storage.getAllVenueInfos();
  assertActive(control);
  const matching = infos.filter(info => info.venueName === name);
  if (matching.length > 1) {
    data.counts.ambiguous++;
    data.failures.push({ kind: "venue", sourceId: String(record._ragicId), code: "AMBIGUOUS_VENUE_INFO" });
    return;
  }
  const info = matching[0];
  if (info?.mapUrl) return;
  const saved = await dependencies.storage.upsertVenueInfo(name, info?.videoUrl ?? null, info?.description ?? null, mapUrl);
  if (!saved) throw new Error("ragic_venue_map_update_unconfirmed");
  data.counts.venueMapsFilled++;
}

async function applyCoach(record: RagicRecord, data: RagicCheckpoint, dependencies: RagicCheckpointDependencies, control: RagicCheckpointControl): Promise<void> {
  const name = field(record, "姓名");
  if (!name || dependencies.excludedNames.has(name) || !isCoachRole(record)) { data.counts.skipped++; return; }
  data.counts.coachesConsidered++;
  const sourceCoaches = data.snapshots.coaches!.filter(row => field(row, "姓名") === name);
  const personal = data.snapshots.employees!.filter(row => field(row, "姓名") === name);
  const ambiguous = (code: string) => { data.counts.ambiguous++; data.failures.push({ kind: "coach", sourceId: String(record._ragicId), code }); };
  if (sourceCoaches.length !== 1) { ambiguous("DUPLICATE_COACH_NAME_IN_RAGIC"); return; }
  if (personal.length > 1) { ambiguous("DUPLICATE_EMPLOYEE_NAME_IN_RAGIC"); return; }
  assertActive(control);
  const accounts = await dependencies.storage.getAllCoachUsers();
  assertActive(control);
  const matching = accounts.filter(account => account.name.trim() === name);
  if (matching.length > 1) { ambiguous("AMBIGUOUS_EXISTING_COACH_ACCOUNTS"); return; }
  const current = matching[0];
  const lineId = personal[0] ? normalizeLineId(field(personal[0], "個人LINE ID")) : null;
  const employeeId = personal[0] ? field(personal[0], "員工編號") || null : null;
  const otherLineOwners = lineId ? accounts.filter(account => account.lineId === lineId && account.id !== current?.id) : [];
  if (!current) {
    const created = await dependencies.storage.createCoachUser({ name, phone: field(record, "手機") || null, email: field(record, "E-mail") || null,
      status: "approved", role: "coach", linkedCoachName: name, lineId: otherLineOwners.length ? null : lineId, employeeId });
    if (!created) throw new Error("ragic_coach_create_unconfirmed");
    data.counts.coachesAdded++;
    if (created.lineId) data.counts.lineIdsFilled++;
    if (created.employeeId) data.counts.employeeIdsFilled++;
    if (otherLineOwners.length) data.counts.lineIdConflicts++;
    return;
  }
  if (lineId && !current.lineId) {
    if (otherLineOwners.length) data.counts.lineIdConflicts++;
    else {
      const updated = await dependencies.storage.updateCoachUserLineId(current.id, lineId);
      if (!updated) throw new Error("ragic_line_update_unconfirmed");
      data.counts.lineIdsFilled++;
    }
  }
  if (employeeId && !current.employeeId) {
    assertActive(control);
    const updated = await dependencies.storage.updateCoachEmployeeId(current.id, employeeId);
    if (!updated) throw new Error("ragic_employee_update_unconfirmed");
    data.counts.employeeIdsFilled++;
  }
}

/** Caller commits each returned checkpoint in the same transaction as this call's business writes. */
export async function advanceRagicCheckpoint(data: RagicCheckpoint, dependencies: RagicCheckpointDependencies, control: RagicCheckpointControl): Promise<{ complete: boolean; data: RagicCheckpoint; stopped: boolean }> {
  validate(data);
  if (data.phase === "complete") return { complete: true, data, stopped: false };
  if (!active(control)) return { complete: false, data, stopped: true };
  const limit = control.limit ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error("invalid_ragic_step_limit");
  const next: RagicCheckpoint = { ...data, snapshots: { ...data.snapshots }, counts: { ...data.counts }, failures: [...data.failures] };
  const fetchPhases: Partial<Record<RagicCheckpointPhase, { source: RagicCheckpointSource; next: RagicCheckpointPhase }>> = {
    fetch_departments: { source: "departments", next: "fetch_coaches" }, fetch_coaches: { source: "coaches", next: "fetch_employees" }, fetch_employees: { source: "employees", next: "apply_departments" },
  };
  const fetchPhase = fetchPhases[data.phase];
  if (fetchPhase) {
    const records = await dependencies.fetchSource(fetchPhase.source, control);
    if (!Array.isArray(records)) throw new Error("invalid_ragic_source_records");
    if (records.length >= 500) throw new Error("ragic_source_completeness_unproven");
    if (!active(control)) return { complete: false, data, stopped: true };
    next.snapshots[fetchPhase.source] = JSON.parse(JSON.stringify(records)) as RagicRecord[];
    next.phase = fetchPhase.next;
    next.cursor = 0;
    return { complete: false, data: next, stopped: false };
  }
  const records = data.phase === "apply_departments" ? next.snapshots.departments! : next.snapshots.coaches!;
  let visited = 0;
  while (next.cursor < records.length && visited < limit && active(control)) {
    if (data.phase === "apply_departments") await applyDepartment(records[next.cursor], next, dependencies, control);
    else await applyCoach(records[next.cursor], next, dependencies, control);
    next.cursor++;
    visited++;
  }
  if (next.cursor === records.length) {
    next.phase = data.phase === "apply_departments" ? "apply_coaches" : "complete";
    next.cursor = 0;
    if (next.phase === "complete") next.status = next.failures.length ? "partial_failed" : "success";
  }
  return { complete: next.phase === "complete", data: next, stopped: !active(control) };
}
