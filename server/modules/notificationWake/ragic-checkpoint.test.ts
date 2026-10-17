import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { advanceRagicCheckpoint, createRagicCheckpoint, type RagicCheckpoint, type RagicCheckpointDependencies, type RagicCheckpointControl } from "./ragic-checkpoint";
import { parseRagicBody } from "../../ragic.logic";

const syntheticLine = (n: number) => "U" + n.toString(16).padStart(32, "0");
function fixture(count = 3) {
  const source = {
    departments: [{ _ragicId: 1, 部門名稱: "synthetic-venue", 營運性質: "synthetic-operation", "google map": "https://example.invalid/map" }],
    coaches: Array.from({ length: count }, (_, n) => ({ _ragicId: n + 1, 姓名: `synthetic-coach-${n}`, 應徵職務: "教練", 手機: `synthetic-phone-${n}`, "E-mail": `synthetic-${n}@example.invalid` })),
    employees: Array.from({ length: count }, (_, n) => ({ _ragicId: n + 1, 姓名: `synthetic-coach-${n}`, "個人LINE ID": syntheticLine(n + 1), 員工編號: `synthetic-employee-${n}` })),
  };
  const users: any[] = [], venues: any[] = [], infos: any[] = [], operations: string[] = [];
  const storage = {
    getVenues: async () => [...venues], getAllVenueInfos: async () => [...infos],
    createVenue: async (name: string, color: string) => { const created = { id: `venue-${venues.length}`, name, color }; venues.push(created); operations.push("create-venue"); return created; },
    upsertVenueInfo: async (venueName: string, videoUrl: string | null, description: string | null, mapUrl: string | null) => { const row = { venueName, videoUrl, description, mapUrl }; const at = infos.findIndex(i => i.venueName === venueName); if (at < 0) infos.push(row); else infos[at] = row; operations.push("fill-map"); return row; },
    getAllCoachUsers: async () => [...users],
    createCoachUser: async (input: any) => { const created = { id: `account-${users.length}`, ...input }; users.push(created); operations.push("create-coach"); return created; },
    updateCoachUserLineId: async (id: string, lineId: string) => { const row = users.find(u => u.id === id); if (!row) return undefined; row.lineId = lineId; operations.push("fill-line"); return row; },
    updateCoachEmployeeId: async (id: string, employeeId: string) => { const row = users.find(u => u.id === id); if (!row) return undefined; row.employeeId = employeeId; operations.push("fill-employee"); return row; },
  };
  const fetches: string[] = [];
  const deps: RagicCheckpointDependencies = { storage, fetchSource: async (kind, control) => { assert.ok(control.signal); assert.ok(Number.isFinite(control.deadlineMs)); fetches.push(kind); return structuredClone(source[kind]); }, excludedNames: new Set(), venueColors: ["blue", "green"] };
  const control = (): RagicCheckpointControl => ({ signal: new AbortController().signal, deadlineMs: 1000, now: () => 0 });
  return { source, users, venues, infos, operations, fetches, storage, deps, control };
}

async function snapshot(f: ReturnType<typeof fixture>) {
  let data = createRagicCheckpoint("2026-10-18");
  for (let n = 0; n < 3; n++) {
    const result = await advanceRagicCheckpoint(data, f.deps, f.control());
    assert.equal(result.complete, false); assert.equal(f.operations.length, 0);
    data = JSON.parse(JSON.stringify(result.data));
  }
  assert.deepEqual(f.fetches, ["departments", "coaches", "employees"]);
  assert.equal(data.phase, "apply_departments");
  return data;
}

test("400 source coaches survive two checkpointed interruptions and restarts without refetch or duplicate apply", async () => {
  const f = fixture(400);
  let data = await snapshot(f);
  const originalSources = structuredClone(data.snapshots);
  let steps = 0;
  while (data.phase !== "complete") {
    if (steps === 101 || steps === 251) {
      const before = JSON.stringify(data), controller = new AbortController(); controller.abort();
      const stopped = await advanceRagicCheckpoint(data, f.deps, { ...f.control(), signal: controller.signal });
      assert.equal(stopped.stopped, true); assert.equal(stopped.complete, false); assert.equal(JSON.stringify(stopped.data), before);
      data = JSON.parse(before);
    }
    const result = await advanceRagicCheckpoint(data, f.deps, f.control());
    data = JSON.parse(JSON.stringify(result.data)); steps++;
    assert.ok(steps < 410);
  }
  assert.equal(data.status, "success"); assert.equal(f.users.length, 400);
  assert.equal(f.operations.filter(x => x === "create-coach").length, 400);
  assert.equal(new Set(f.users.map(u => u.name)).size, 400);
  assert.deepEqual(data.snapshots, originalSources);
  assert.equal(f.fetches.length, 3);
  assert.equal(f.venues.length, 1);
});

test("coach source, employee source, and existing accounts sharing names are all held back", async () => {
  for (const duplicateAt of ["coaches", "employees", "accounts"]) {
    const f = fixture(1);
    if (duplicateAt === "coaches") f.source.coaches.push({ ...f.source.coaches[0], _ragicId: 88 });
    if (duplicateAt === "employees") f.source.employees.push({ ...f.source.employees[0], _ragicId: 88 });
    if (duplicateAt === "accounts") f.users.push({ id: "old-approved", name: f.source.coaches[0].姓名, status: "approved", lineId: null, employeeId: null }, { id: "old-rejected", name: f.source.coaches[0].姓名, status: "rejected", lineId: null, employeeId: null });
    let data = await snapshot(f);
    while (data.phase !== "complete") data = (await advanceRagicCheckpoint(data, f.deps, f.control())).data;
    assert.equal(data.status, "partial_failed", duplicateAt);
    assert.ok(data.counts.ambiguous > 0, duplicateAt);
    assert.equal(f.operations.filter(x => /coach|line|employee/.test(x)).length, 0, duplicateAt);
  }
});

test("fill missing only, preserve nonempty fields and absent accounts, never rebind an existing LINE owner", async () => {
  const f = fixture(3);
  f.users.push({ id: "existing-0", name: f.source.coaches[0].姓名, lineId: "original-line", employeeId: "original-employee", phone: "original-phone", email: "original-email", status: "approved" });
  f.users.push({ id: "existing-1", name: f.source.coaches[1].姓名, lineId: null, employeeId: null, status: "approved" });
  f.users.push({ id: "absent-account", name: "synthetic-absent", lineId: syntheticLine(3), employeeId: "keep-me", status: "approved" });
  f.infos.push({ venueName: "synthetic-venue", mapUrl: null, videoUrl: "preserve-video", description: "preserve-description" });
  const preserved = structuredClone([f.users[0], f.users[2]]);
  let data = await snapshot(f);
  while (data.phase !== "complete") data = (await advanceRagicCheckpoint(data, f.deps, f.control())).data;
  assert.deepEqual([f.users[0], f.users[2]], preserved);
  assert.equal(f.users[1].lineId, syntheticLine(2)); assert.equal(f.users[1].employeeId, "synthetic-employee-1");
  assert.equal(f.users[3].lineId, null, "new account may not steal an already-owned LINE ID");
  assert.equal(f.infos[0].videoUrl, "preserve-video"); assert.equal(f.infos[0].description, "preserve-description");
  assert.equal(f.infos[0].mapUrl, "https://example.invalid/map");
});

test("missing personal row does not clear existing identifiers; empty sources delete nothing", async () => {
  const f = fixture(1); f.source.employees.length = 0;
  f.users.push({ id: "saved", name: f.source.coaches[0].姓名, lineId: "keep-line", employeeId: "keep-employee" });
  const before = structuredClone(f.users);
  let data = await snapshot(f);
  while (data.phase !== "complete") data = (await advanceRagicCheckpoint(data, f.deps, f.control())).data;
  assert.deepEqual(f.users, before);
  const empty = fixture(0); empty.source.departments.length = 0; empty.users.push(...before);
  let none = await snapshot(empty);
  while (none.phase !== "complete") none = (await advanceRagicCheckpoint(none, empty.deps, empty.control())).data;
  assert.equal(none.status, "success"); assert.deepEqual(empty.users, before); assert.equal(empty.operations.length, 0);
});

test("deadline before a phase does zero I/O and abort during a completed fetch never starts apply", async () => {
  const f = fixture(1), initial = createRagicCheckpoint("2026-10-18");
  const stopped = await advanceRagicCheckpoint(initial, f.deps, { ...f.control(), deadlineMs: 0 });
  assert.equal(stopped.stopped, true); assert.equal(f.fetches.length, 0);
  const controller = new AbortController();
  f.deps.fetchSource = async () => { controller.abort(); return f.source.departments; };
  const interrupted = await advanceRagicCheckpoint(initial, f.deps, { ...f.control(), signal: controller.signal });
  assert.equal(interrupted.complete, false); assert.equal(interrupted.stopped, true);
  assert.equal(interrupted.data.phase, "fetch_departments"); assert.equal(f.operations.length, 0);
});

test("500-record source without proven pagination fails closed before storing snapshot or applying", async () => {
  const f = fixture(1), initial = createRagicCheckpoint("2026-10-18");
  f.deps.fetchSource = async () => Array.from({ length: 500 }, (_, n) => ({ _ragicId: n, 部門名稱: `synthetic-${n}` }));
  await assert.rejects(advanceRagicCheckpoint(initial, f.deps, f.control()), /ragic_source_completeness_unproven/);
  assert.equal(initial.phase, "fetch_departments"); assert.deepEqual(initial.snapshots, {}); assert.equal(f.operations.length, 0);
});

test("storage/lock errors propagate without completed status or input checkpoint mutation", async () => {
  const f = fixture(1), data = await snapshot(f), before = JSON.stringify(data);
  f.storage.getVenues = async () => { throw new Error("synthetic_lock_error"); };
  await assert.rejects(advanceRagicCheckpoint(data, f.deps, f.control()), /synthetic_lock_error/);
  assert.equal(JSON.stringify(data), before); assert.notEqual(data.status, "success");
  assert.equal(f.operations.length, 0);
});

test("mid-item write failure propagates with unchanged checkpoint, requiring caller transaction rollback", async () => {
  const f = fixture(1);
  f.users.push({ id: "saved", name: f.source.coaches[0].姓名, lineId: null, employeeId: null });
  let data = await snapshot(f);
  data = (await advanceRagicCheckpoint(data, f.deps, f.control())).data;
  const before = JSON.stringify(data);
  f.storage.updateCoachEmployeeId = async () => { throw new Error("synthetic_after_line_write"); };
  await assert.rejects(advanceRagicCheckpoint(data, f.deps, f.control()), /synthetic_after_line_write/);
  assert.equal(JSON.stringify(data), before, "failed apply never advances its caller's checkpoint");
  assert.deepEqual(f.operations.slice(-1), ["fill-line"], "caller must roll this prior write back atomically, not retain it with an old cursor");
  assert.notEqual(data.status, "success");
});

test("bounded adapter preserves venue exclusions/aliases, filled map URLs and coach exclusions", async () => {
  const f = fixture(1);
  f.venues.push({ id: "original", name: "synthetic-campus", color: "keep-color" });
  f.source.departments = [
    { _ragicId: 1, 部門名稱: "勞務-synthetic-campus", 營運性質: "synthetic-operation", "google map": "https://example.invalid/alias" },
    { _ragicId: 2, 部門名稱: "synthetic-internal", 營運性質: "內勤單位", "google map": "https://example.invalid/internal" },
    { _ragicId: 3, 部門名稱: "synthetic-campus", 營運性質: "synthetic-operation", "google map": "https://example.invalid/new-map" },
  ];
  f.infos.push({ venueName: "synthetic-campus", videoUrl: "keep-video", description: "keep-description", mapUrl: "https://example.invalid/original-map" });
  f.deps.excludedNames = new Set([f.source.coaches[0].姓名]);
  let data = await snapshot(f);
  while (data.phase !== "complete") data = (await advanceRagicCheckpoint(data, f.deps, f.control())).data;
  assert.equal(f.venues.length, 1); assert.equal(f.venues[0].color, "keep-color"); assert.equal(f.operations.length, 0);
  assert.equal(f.infos[0].mapUrl, "https://example.invalid/original-map");
  assert.equal(f.users.length, 0); assert.equal(data.counts.skipped, 3);
});

test("invalid checkpoint completion/status or missing counters fails closed", async () => {
  const f = fixture(1), data = createRagicCheckpoint("2026-10-18");
  for (const malformed of [{ ...data, status: "success" }, { ...data, counts: {} }]) {
    await assert.rejects(advanceRagicCheckpoint(malformed as RagicCheckpoint, f.deps, f.control()), /invalid_ragic_checkpoint/);
  }
  assert.equal(f.fetches.length, 0);
});

function boundedFetch(globals: Record<string, unknown>) {
  const source = readFileSync(new URL("../../ragic.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ragic.ts", source, ts.ScriptTarget.ES2022, true);
  const node = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "fetchBoundedRagicSource");
  assert.ok(node);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(node.getText(ast) + "\nmodule.exports=fetchBoundedRagicSource;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Date, parseRagicBody, RAGIC_DEPT_API_URL: "https://example.invalid/departments", RAGIC_COACH_API_URL: "https://example.invalid/coaches", RAGIC_EMPLOYEE_API_URL: "https://example.invalid/employees", ...globals }, { timeout: 5000 });
  return module.exports as (...args: any[]) => Promise<any>;
}

test("bounded fetch has explicit signal/deadline, <=8s timeout and no retry, with sanitized absence/error", async () => {
  const f = fixture(1), calls: any[] = [], control = f.control();
  const fetcher = boundedFetch({ process: { env: { RAGIC_API_KEY: "synthetic-key" } }, fetchWithTimeout: async (_url: string, options: any) => { calls.push(options); return { ok: false, status: 503, errorMessage: "never expose upstream body" }; } });
  await assert.rejects(fetcher("departments", control), /ragic_source_http_failed/);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal, control.signal);
  assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 1000);
});

test("bounded fetch rejects empty/error bodies and a full page; credentials absence does zero HTTP", async () => {
  const f = fixture(1); let calls = 0;
  const missing = boundedFetch({ process: { env: {} }, fetchWithTimeout: async () => { calls++; throw new Error("must not call"); } });
  await assert.rejects(missing("departments", f.control()), /ragic_api_key_not_configured/); assert.equal(calls, 0);
  for (const body of ["", '{"status":"ERROR","msg":"synthetic"}', JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, n) => [n, { _ragicId: n }])))]) {
    const fetcher = boundedFetch({ process: { env: { RAGIC_API_KEY: "synthetic-key" } }, fetchWithTimeout: async () => ({ ok: true, body }) });
    await assert.rejects(fetcher("employees", f.control()), /ragic_source_(empty|api_error|completeness_unproven)/);
  }
});

test("bounded fetch caps timeout at eight seconds and sanitizes thrown transport detail", async () => {
  const f = fixture(1), control = { ...f.control(), deadlineMs: 50_000 }, calls: any[] = [];
  const fetcher = boundedFetch({ process: { env: { RAGIC_API_KEY: "synthetic-key" } }, fetchWithTimeout: async (_url: string, options: any) => { calls.push(options); throw new Error("synthetic-private-upstream-detail"); } });
  await assert.rejects(fetcher("coaches", control), (error: Error) => error.message === "ragic_source_transport_failed");
  assert.equal(calls.length, 1); assert.equal(calls[0].timeoutMs, 8000);
});
