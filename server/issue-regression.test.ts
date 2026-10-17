import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { logTimestamp } from "./shared/logTimestamp";

process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
// #3: no real transactions or audit inserts here; audit rows are collected instead.
const { db } = await import("./db");
(db as unknown as { transaction: unknown }).transaction = async (fn: (tx: unknown) => unknown) => fn(db);
const { setAuditWriterForTest } = await import("./shared/audit");
const auditRows: Array<Record<string, any>> = [];
const collectAudit = async (entry: Record<string, any>) => { auditRows.push(entry); };
setAuditWriterForTest(collectAudit as never);
const { setSchedulingLocksForTest } = await import("./infrastructure/scheduling/composition");
// This suite uses storage stand-ins; real advisory locks are tested on throwaway PostgreSQL.
setSchedulingLocksForTest({ acquire: async () => {} });
const { notifyCoachNotFound, coachNotFoundMessage } = await import("./modules/notification/coachNotFound");
const { probeHttpService } = await import("./shared/serviceHealth");
const { fetchWithTimeout } = await import("./shared/http/fetchWithTimeout");

test("notification reports missing recipient/token and never claims delivery", async () => {
  const send = async () => { throw new Error("must not send"); };
  for (const config of [{ token: "test", recipient: null }, { token: null, recipient: "test" }]) {
    const result = await notifyCoachNotFound("synthetic", config, send);
    assert.equal(result.status, "not_configured");
    assert.match(coachNotFoundMessage(result), /尚未設定/);
  }
});

test("isolated HTTP 2xx, 4xx, 5xx, timeout and recovery produce honest states", async () => {
  let mode = 200;
  const server = createServer((_req, res) => {
    if (mode === 0) return; // deliberately stalled local service
    res.writeHead(mode, { "Content-Type": "application/json" });
    res.end(mode === 200 ? JSON.stringify({ userId: "test-bot" }) : "synthetic failure");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const send: typeof fetchWithTimeout = (_url, opts) => fetchWithTimeout(`http://127.0.0.1:${port}`, { ...opts, timeoutMs: 100 });
  try {
    for (const [status, expected] of [[200, "ok"], [400, "error"], [500, "error"], [0, "timeout"], [200, "ok"]] as const) {
      mode = status;
      const health = await probeHttpService({ enabled: true, configured: true, url: "unused", kind: "line" }, send);
      assert.equal(health.status, expected);
      const notice = await notifyCoachNotFound("synthetic", { recipient: "test", token: "test" }, send);
      assert.equal(notice.status, status === 200 ? "accepted" : "failed");
      assert.equal(coachNotFoundMessage(notice).includes("LINE 接受"), status === 200);
    }
    const invalid = await probeHttpService({ enabled: true, configured: true, url: "unused", kind: "ragic" }, send);
    assert.equal(invalid.status, "error");
    const healthyRagic: typeof send = async () => ({ ok: true, status: 200, body: '{"1":{"_ragicId":1,"name":"test"}}', errorCode: null, errorMessage: null });
    const staleError = await probeHttpService({ enabled: true, configured: true, url: "unused", kind: "ragic", lastError: { message: "failed" } }, healthyRagic);
    assert.equal(staleError.code, "last_sync_failed");
    assert.equal((await probeHttpService({ enabled: true, configured: true, url: "unused", kind: "ragic" }, healthyRagic)).status, "ok");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("same instant logs the same date and offset in UTC and Taipei processes", () => {
  const instant = "2026-09-17T16:05:06.123Z";
  const expected = logTimestamp(new Date(instant));
  for (const TZ of ["UTC", "Asia/Taipei"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {logTimestamp} from './server/shared/logTimestamp.ts'; console.log(logTimestamp(new Date('${instant}')))`], { env: { ...process.env, TZ }, encoding: "utf-8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), expected);
    assert.equal(Date.parse(child.stdout.trim()), Date.parse(instant));
  }
  assert.match(expected, /2026-09-17T16:05:06.123\+00:00/);
});

test("#2 coach PII endpoints reject anonymous callers before touching the database", async () => {
  process.env.REPLIT_DOMAINS ??= "test.invalid";
  const express = (await import("express")).default;
  const { registerCoachRoutes } = await import("./modules/coach.routes");
  const { registerCoachPortalRoutes } = await import("./modules/coachPortal.routes");
  const app = express();
  app.use(express.json());
  registerCoachRoutes(app);
  registerCoachPortalRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of [
      "/api/approved-coaches",
      "/api/coach-portal/approved-coaches",
      "/api/coach-portal/linkable-coaches",
      "/api/coach-portal/colleagues?coachName=synthetic&date=2026-10-12&venueIds=synthetic",
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 401, path);
    }
    // The public /coach page lists names only; it stays public by decision.
    assert.notEqual((await fetch(base + "/api/coaches")).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("#6 schedule writes enforce lock, conflict and availability rules on the server", async () => {
  process.env.REPLIT_DOMAINS ??= "test.invalid";
  const express = (await import("express")).default;
  const { registerScheduleRoutes } = await import("./modules/schedule.routes");
  const { storage } = await import("./storage");
  const { env } = await import("./config/env");
  // 2026-10-14 is a Wednesday (day 3); its week starts Monday 2026-10-12.
  const base = { date: "2026-10-14", timeSlotId: "slot-3", coachName2: null, coachCount: 2, coach1IsTeaching: true, coach2IsTeaching: false, notes: null, version: 1 };
  const rows = [
    { ...base, id: "locked-row", venueId: "v1", className: "A班", coachName: null, isClassLocked: true, venue: { name: "場館一" } },
    { ...base, id: "other-venue", venueId: "v2", className: "B班", coachName: "王教練", isClassLocked: false, venue: { name: "場館二" } },
    { ...base, id: "dup-row", venueId: "v3", className: "C班", coachName: "王教練", isClassLocked: false, venue: { name: "場館三" } },
    { ...base, id: "same-venue", venueId: "v1", className: "D班", coachName: "周教練", isClassLocked: true, venue: { name: "場館一" } },
  ];
  const availability = [
    { coachName: "陳教練", weekStart: "2026-10-12", dayOfWeek: 1, timeSlotOrder: 1 },
    { coachName: "林教練", weekStart: "2026-10-12", dayOfWeek: 3, timeSlotOrder: 3 },
  ];
  const writes: unknown[] = [];
  const fake = (id: string, update: object) => { writes.push([id, update]); return { ...rows.find(r => r.id === id), ...update }; };
  Object.assign(storage, {
    getScheduleById: async (id: string) => rows.find(r => r.id === id),
    getSchedulesByDate: async (date: string) => rows.filter(r => r.date === date),
    getTimeSlots: async () => [{ id: "slot-3", order: 3 }],
    getVenues: async () => [],
    getCoachAvailabilityByWeek: async (weekStart: string) => availability.filter(a => a.weekStart === weekStart),
    updateSchedule: async (id: string, update: object) => fake(id, update),
    assignCoach: async (id: string, coachName: string | null) => fake(id, { coachName }),
    upsertSchedule: async (row: object) => { writes.push(["insert", row]); return { id: "new", ...row }; },
  });
  const app = express();
  app.use(express.json());
  registerScheduleRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (method: string, path: string, body: object) => {
    const res = await fetch(url + path, { method, headers: { "Content-Type": "application/json", "x-admin-password": env.adminPassword }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const expectBlocked = async (method: string, path: string, body: object, code: string, warning?: string) => {
    const before = writes.length;
    const res = await send(method, path, body);
    assert.equal(res.status, 409, `${method} ${path} ${JSON.stringify(body)}`);
    assert.equal(res.body.code, code);
    if (warning) assert.ok(res.body.warnings.some((w: { code: string }) => w.code === warning), JSON.stringify(res.body));
    assert.equal(writes.length, before, "a blocked request must not write");
  };
  const expectSaved = async (method: string, path: string, body: object) => {
    let res = await send(method, path, body);
    if (res.body.code === "CONFIRM_REQUIRED" && "confirmWarnings" in body) {
      assert.equal(typeof res.body.confirmationToken, "string");
      res = await send(method, path, { ...body, confirmationToken: res.body.confirmationToken });
    }
    assert.equal(res.status, 200, `${method} ${path} ${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
  };
  try {
    // Locked venue/date: class names are frozen, coach assignment still allowed.
    await expectBlocked("POST", "/api/schedules", { date: "2026-10-14", venueId: "v1", timeSlotId: "slot-3", className: "新班" }, "SCHEDULE_LOCKED");
    await expectBlocked("PUT", "/api/schedules/locked-row", { expectedVersion: 1, className: "改名", coachName: null }, "SCHEDULE_LOCKED");
    await expectSaved("PUT", "/api/schedules/locked-row", { expectedVersion: 1, className: "A班", coachName: "林教練" });
    // Cross-venue conflict needs confirmation, then goes through.
    await expectBlocked("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "王教練" }, "CONFIRM_REQUIRED", "COACH_CONFLICT");
    await expectBlocked("PATCH", "/api/schedules/locked-row", { expectedVersion: 1, coachName2: "王教練" }, "CONFIRM_REQUIRED", "COACH_CONFLICT");
    await expectBlocked("POST", "/api/schedules", { date: "2026-10-14", venueId: "v4", timeSlotId: "slot-3", className: "D班", coachName: "王教練" }, "CONFIRM_REQUIRED", "COACH_CONFLICT");
    await expectSaved("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "王教練", confirmWarnings: ["COACH_CONFLICT"] });
    // Filled availability this week but not this slot: needs confirmation.
    await expectBlocked("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "陳教練" }, "CONFIRM_REQUIRED", "COACH_UNAVAILABLE");
    await expectBlocked("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "陳教練", confirmWarnings: ["COACH_CONFLICT"] }, "CONFIRM_REQUIRED", "COACH_UNAVAILABLE");
    await expectSaved("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "陳教練", confirmWarnings: ["COACH_UNAVAILABLE"] });
    // No availability filled at all, placeholders and unchanged coaches are not nagged.
    await expectSaved("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "張教練" });
    await expectSaved("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "000" });
    await expectSaved("PUT", "/api/schedules/locked-row/assign-coach", { expectedVersion: 1, coachName: "周教練" });
    await expectSaved("PUT", "/api/schedules/dup-row", { expectedVersion: 1, className: "C班改", coachName: "王教練" });
    await expectSaved("POST", "/api/schedules", { date: "2026-10-14", venueId: "v4", timeSlotId: "slot-3", className: "E班" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("#8 schedule writes need the version the editor saw; stale or concurrent saves are refused", async () => {
  process.env.REPLIT_DOMAINS ??= "test.invalid";
  const express = (await import("express")).default;
  const { registerScheduleRoutes } = await import("./modules/schedule.routes");
  const { ScheduleVersionConflictError } = await import("./repositories/schedule.repository");
  const { storage } = await import("./storage");
  const { env } = await import("./config/env");
  const row = { id: "row", date: "2099-01-07", venueId: "v1", timeSlotId: "slot-3", className: "A班", coachName: null, coachName2: null, coachCount: 2, coach1IsTeaching: true, coach2IsTeaching: false, isClassLocked: false, notes: null, version: 3, venue: { name: "場館一" } };
  const writes: unknown[] = [];
  let raceOnNextWrite = false;
  const write = (id: string, update: object, expectedVersion?: number) => {
    // A concurrent save landing between our read and our write.
    if (raceOnNextWrite || (expectedVersion !== undefined && expectedVersion !== row.version)) {
      raceOnNextWrite = false;
      throw new ScheduleVersionConflictError();
    }
    writes.push([id, update, expectedVersion]);
    return { ...row, ...update, version: row.version + 1 };
  };
  Object.assign(storage, {
    getScheduleById: async (id: string) => (id === row.id ? row : undefined),
    getSchedulesByDate: async () => [row],
    getTimeSlots: async () => [{ id: "slot-3", order: 3 }],
    getVenues: async () => [],
    getCoachAvailabilityByWeek: async () => [],
    updateSchedule: async (id: string, update: object, expectedVersion?: number) => write(id, update, expectedVersion),
    assignCoach: async (id: string, coachName: string | null, expectedVersion?: number) => write(id, { coachName }, expectedVersion),
    deleteSchedule: async (id: string, expectedVersion?: number) => { write(id, { deleted: true }, expectedVersion); },
  });
  const app = express();
  app.use(express.json());
  registerScheduleRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (method: string, path: string, body?: object) => {
    const res = await fetch(url + path, { method, headers: { "Content-Type": "application/json", "x-admin-password": env.adminPassword }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const expect = async (method: string, path: string, body: object | undefined, status: number, code?: string) => {
    const before = writes.length;
    const res = await send(method, path, body);
    assert.equal(res.status, status, `${method} ${path} ${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
    if (code) assert.equal(res.body.code, code);
    if (status !== 200) assert.equal(writes.length, before, "a refused request must not write");
  };
  try {
    await expect("PUT", "/api/schedules/row", { className: "A班", coachName: null }, 428, "VERSION_REQUIRED");
    await expect("PUT", "/api/schedules/row", { className: "A班改", coachName: null, expectedVersion: 2 }, 409, "VERSION_CONFLICT");
    await expect("PATCH", "/api/schedules/row", { coachCount: 1 }, 428, "VERSION_REQUIRED");
    await expect("PATCH", "/api/schedules/row", { coachCount: 1, expectedVersion: 2 }, 409, "VERSION_CONFLICT");
    await expect("PUT", "/api/schedules/row/assign-coach", { coachName: "王教練" }, 428, "VERSION_REQUIRED");
    await expect("PUT", "/api/schedules/row/assign-coach", { coachName: "王教練", expectedVersion: 2 }, 409, "VERSION_CONFLICT");
    await expect("DELETE", "/api/schedules/row", undefined, 428, "VERSION_REQUIRED");
    await expect("DELETE", "/api/schedules/row?expectedVersion=2", undefined, 409, "VERSION_CONFLICT");
    // Someone else saves between our read and our write: still refused.
    raceOnNextWrite = true;
    await expect("PUT", "/api/schedules/row", { className: "A班改", coachName: null, expectedVersion: 3 }, 409, "VERSION_CONFLICT");
    // The version the editor saw goes through, and is what the write is conditioned on.
    await expect("PUT", "/api/schedules/row", { className: "A班改", coachName: null, expectedVersion: 3 }, 200);
    assert.equal((writes.at(-1) as unknown[])[2], 3);
    await expect("PUT", "/api/schedules/row/assign-coach", { coachName: "王教練", expectedVersion: 3 }, 200);
    await expect("PATCH", "/api/schedules/row", { coachCount: 1, expectedVersion: 3 }, 200);
    await expect("DELETE", "/api/schedules/row?expectedVersion=3", undefined, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("#6 conflict list counts a coach only when the same period spans different venues", async () => {
  const { ScheduleRepository } = await import("./repositories/schedule.repository");
  const repo = new ScheduleRepository();
  const row = (id: string, venue: string, coachName: string, timeSlotId = "slot-1") =>
    ({ id, timeSlotId, coachName, coachName2: null, venue: { name: venue } });
  Object.assign(repo, {
    getSchedulesByDate: async () => [
      row("a", "新北高中", "段考"), row("b", "新北高中", "段考"),
      row("c", "新北高中", "鄭教練"), row("d", "新北高中", "鄭教練"),
      row("e", "三民高中", "王教練"), row("f", "新北高中", "王教練"),
    ],
  });
  const conflicts = await repo.getConflicts("2026-10-15");
  assert.deepEqual(conflicts.map(c => [c.coachName, [...c.venues].sort()]), [["王教練", ["三民高中", "新北高中"]]]);
});

test("#1 Ragic sync keeps failed items, refuses to merge same-name rows and reports a partial run", async () => {
  process.env.RAGIC_API_KEY ??= "test-key";
  const ragic = await import("./ragic");
  const { storage } = await import("./storage");
  const LINE_TAKEN = "U" + "0123456789abcdef".repeat(2);
  const sheets: Record<string, object> = {
    "ragicforms4/7": { "1": { _ragicId: 1, 部門名稱: "既有場館", 營運性質: "" } },
    "general-information/23": {
      "11": { _ragicId: 11, 姓名: "新教練甲", 應徵職務: "教練" },
      "12": { _ragicId: 12, 姓名: "同名教練", 應徵職務: "教練" },
      "13": { _ragicId: 13, 姓名: "同名教練", 應徵職務: "教練" },
      "14": { _ragicId: 14, 姓名: "既有教練乙", 應徵職務: "教練" },
    },
    "ragicforms4/20004": {
      "21": { _ragicId: 21, 姓名: "既有教練乙", "個人LINE ID": LINE_TAKEN },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const key = Object.keys(sheets).find((k) => String(url).includes(k));
    return new Response(JSON.stringify(key ? sheets[key] : {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const created: string[] = [];
  Object.assign(storage, {
    getVenues: async () => [{ id: "v", name: "既有場館", color: "blue", order: 1 }],
    getAllVenueInfos: async () => [],
    getAllCoachUsers: async () => [
      { id: "owner", name: "別人", status: "approved", lineId: LINE_TAKEN, employeeId: null, createdAt: new Date(0) },
      { id: "b", name: "既有教練乙", status: "approved", lineId: null, employeeId: "E1", createdAt: new Date(0) },
    ],
    createCoachUser: async (data: { name: string }) => { created.push(data.name); return { id: `new-${data.name}`, lineId: null, ...data }; },
    updateCoachUserLineId: async () => { throw new Error("must not rebind a LINE ID owned by someone else"); },
    updateCoachEmployeeId: async () => undefined,
  });
  const runs: { trigger: string; outcome?: { status: string; failures: { code: string; sourceId: string }[]; errorCode?: string | null } }[] = [];
  ragic.setRagicRunStoreForTest({
    start: async (trigger) => { runs.push({ trigger }); return `run-${runs.length}`; },
    finish: async (_id, outcome) => { runs[runs.length - 1].outcome = outcome; },
  });
  try {
    ragic.setRagicSyncLockForTest(async () => ({ release: async () => {} }));
    await ragic.syncRagicAll("manual");
    assert.deepEqual(created, ["新教練甲"], "same-name rows must not create or merge accounts");
    const outcome = runs.at(-1)!.outcome!;
    assert.equal(runs.at(-1)!.trigger, "manual");
    assert.equal(outcome.status, "partial_failed");
    assert.deepEqual(outcome.failures.map((f) => `${f.code}:${f.sourceId}`).sort(),
      ["DUPLICATE_NAME_IN_RAGIC:12", "DUPLICATE_NAME_IN_RAGIC:13"]);
    assert.ok(ragic.getRagicSyncStatus().lastError, "a partial run must not look like a clean success");

    // Another instance already holds the sync lock: this one starts no run.
    const before = runs.length;
    ragic.setRagicSyncLockForTest(async () => null);
    await ragic.syncRagicAll("startup");
    assert.equal(runs.length, before);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("API readiness polling 503 never queues logs while other errors and similar-route 503s still write", async () => {
  const express = (await import("express")).default;
  const { apiLogMiddleware, setAppLogWriterForTest, flushAppLogForTest, appLogQueueStats } = await import("./shared/appLog");
  const rows: { level: string; route?: string | null; status?: number | null }[] = [];
  let writes = 0;
  setAppLogWriterForTest(async (entries) => { writes++; rows.push(...entries); });
  const app = express();
  app.use(apiLogMiddleware);
  let readinessStatus = 503;
  app.get("/api/admin/weekly-push/readiness", (_req, res) => { res.status(readinessStatus).json({ code: "NOT_READY" }); });
  for (const route of ["/api/ordinary-service",
    "/api/admin/weekly-push/readiness-extra", "/api/admin/weekly-push/readiness/details"]) {
    app.get(route, (_req, res) => { res.status(503).json({ code: "NOT_READY" }); });
  }
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (let poll = 0; poll < 3; poll++) {
      assert.equal((await fetch(`${url}/api/admin/weekly-push/readiness?poll=${poll}`)).status, 503);
      await flushAppLogForTest();
      assert.equal(writes, 0, "expected readiness 503 must not invoke the log writer");
      assert.deepEqual(appLogQueueStats(), { pending: 0, activeWrites: 0, dropped: 0 });
    }
    for (const status of [500, 401]) {
      readinessStatus = status;
      assert.equal((await fetch(`${url}/api/admin/weekly-push/readiness`)).status, status);
    }
    await flushAppLogForTest();
    assert.deepEqual(rows.map((row) => [row.level, row.route, row.status]), [
      ["error", "/api/admin/weekly-push/readiness", 500],
      ["warn", "/api/admin/weekly-push/readiness", 401],
    ], "unexpected readiness failures and authorization refusals must remain observable");
    for (const route of ["/api/ordinary-service", "/api/admin/weekly-push/readiness-extra",
      "/api/admin/weekly-push/readiness/details"]) {
      assert.equal((await fetch(url + route)).status, 503);
    }
    await flushAppLogForTest();
    assert.deepEqual(rows.map((row) => [row.level, row.route, row.status]), [
      ["error", "/api/admin/weekly-push/readiness", 500],
      ["warn", "/api/admin/weekly-push/readiness", 401],
      ["error", "/api/ordinary-service", 503],
      ["error", "/api/admin/weekly-push/readiness-extra", 503],
      ["error", "/api/admin/weekly-push/readiness/details", 503],
    ]);
    assert.equal(writes, 5);
  } finally {
    await flushAppLogForTest();
    setAppLogWriterForTest(async () => {});
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("API log keeps route templates only, splits errors from refusals, skips the IT page and never blocks", async () => {
  const express = (await import("express")).default;
  const { apiLogMiddleware, setAppLogWriterForTest, flushAppLogForTest, appLogQueueStats, recordAppLog, UNMATCHED_ROUTE } = await import("./shared/appLog");
  const rows: { level: string; route?: string | null; status?: number | null }[] = [];
  setAppLogWriterForTest(async (entries) => { rows.push(...entries); });
  const app = express();
  app.use(apiLogMiddleware);
  app.get("/api/coach-portal/me/:identifier", (_req, res) => { res.status(500).json({ message: "boom" }); });
  app.get("/api/schedules", (_req, res) => { res.status(409).json({ message: "locked" }); });
  app.get("/api/venues", (_req, res) => { res.json([]); });
  app.get("/api/admin/it/logs", (_req, res) => { res.status(401).json({ message: "需要管理員密碼" }); });
  app.post("/api/internal/notification-wake", (_req, res) => { res.status(401).json({ code: "AUTHORIZATION_REQUIRED" }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const secretId = "U" + "0123456789abcdef".repeat(2);
    const res = await fetch(`${url}/api/coach-portal/me/${secretId}?password=secret`);
    assert.ok(res.headers.get("x-request-id"));
    await fetch(`${url}/api/schedules?coachName=王教練`);
    await fetch(`${url}/api/venues`);
    await fetch(`${url}/api/admin/it/logs`);
    await fetch(`${url}/api/internal/notification-wake`, { method: "POST" });
    await fetch(`${url}/api/no-such-thing/${secretId}`);
    await flushAppLogForTest();
    assert.deepEqual(rows.map((r) => [r.level, r.route, r.status]), [
      ["error", "/api/coach-portal/me/:identifier", 500],
      ["warn", "/api/schedules", 409],
      ["warn", UNMATCHED_ROUTE, 404],
    ]);
    assert.ok(!JSON.stringify(rows).includes(secretId) && !JSON.stringify(rows).includes("secret") && !JSON.stringify(rows).includes("王教練"));

    // A stuck database must not pile up requests: the queue is bounded and drops the overflow.
    setAppLogWriterForTest(() => new Promise(() => {}));
    for (let i = 0; i < 700; i++) recordAppLog({ level: "error", source: "api" });
    assert.ok(appLogQueueStats().dropped > 0);
    assert.ok(appLogQueueStats().pending <= 500);
  } finally {
    setAppLogWriterForTest(async () => {});
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("IT page data endpoints need the admin password; problem Ragic runs sort first", async () => {
  const express = (await import("express")).default;
  const { registerItObservabilityRoutes, runPriority } = await import("./modules/itObservability.routes");
  const app = express();
  registerItObservabilityRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const path of ["/api/admin/it/activity", "/api/admin/it/logs", "/api/admin/it/ragic-runs", "/api/admin/it/endpoint-stats"]) {
      assert.equal((await fetch(url + path)).status, 401, path);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  const order = ["success", "partial_failed", "running", "interrupted", "failed"].sort((a, b) => runPriority(a) - runPriority(b));
  assert.deepEqual(order.slice(0, 2).sort(), ["failed", "interrupted"]);
  assert.deepEqual(order.slice(2), ["partial_failed", "running", "success"]);
});

test("#3 each write leaves one audit row with before/after and no contact details; a failed audit write fails the request", async () => {
  process.env.REPLIT_DOMAINS ??= "test.invalid";
  const express = (await import("express")).default;
  const { registerScheduleRoutes } = await import("./modules/schedule.routes");
  const { registerCoachAdminRoutes } = await import("./modules/coachAdmin.routes");
  const { recordAudit } = await import("./shared/audit");
  const { storage } = await import("./storage");
  const { env } = await import("./config/env");
  const row = { id: "row", date: "2099-02-04", venueId: "v1", timeSlotId: "slot-3", className: "A班", coachName: null, coachName2: null, coachCount: 1, coach1IsTeaching: true, coach2IsTeaching: false, isClassLocked: false, notes: null, version: 1 };
  const coach = { id: "c1", name: "林教練", status: "pending", linkedCoachName: null, lineId: "U-secret-line", phone: "0912-000-111", email: "secret@example.com" };
  Object.assign(storage, {
    getScheduleById: async () => row,
    getSchedulesByDate: async () => [row],
    getTimeSlots: async () => [{ id: "slot-3", order: 3 }],
    getVenues: async () => [{ id: "v1", name: "場館一" }],
    getCoachAvailabilityByWeek: async () => [],
    updateSchedule: async (_id: string, update: object) => ({ ...row, ...update, version: 2 }),
    lockSchedules: async () => {},
    getCoachUserById: async () => coach,
    getCoachUserByLineId: async () => undefined,
    updateCoachUserStatus: async (_id: string, status: string) => ({ ...coach, status }),
    updateCoachUserLineId: async (_id: string, lineId: string) => ({ ...coach, lineId }),
  });
  const app = express();
  app.use(express.json());
  registerScheduleRoutes(app);
  registerCoachAdminRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (method: string, path: string, body: object) =>
    (await fetch(url + path, { method, headers: { "Content-Type": "application/json", "x-admin-password": env.adminPassword }, body: JSON.stringify(body) })).status;
  try {
    auditRows.length = 0;
    assert.equal(await send("PUT", "/api/schedules/row", { expectedVersion: 1, className: "A班改", coachName: null }), 200);
    assert.equal(auditRows.length, 1);
    const [edit] = auditRows;
    assert.deepEqual([edit.action, edit.entity, edit.entityId, edit.actor], ["schedule.update", "schedule", "row", "共用管理員"]);
    assert.equal(edit.before.className, "A班");
    assert.equal(edit.after.className, "A班改");
    assert.equal(edit.reason, "場館一 2099-02-04 第3節 A班");

    assert.equal(await send("POST", "/api/schedules/lock", { venueId: "v1", startDate: "2099-02-02", endDate: "2099-02-08" }), 200);
    assert.deepEqual([auditRows[1].action, auditRows[1].entity, auditRows[1].after.venueName], ["schedule.lock", "schedule_week", "場館一"]);

    assert.equal(await send("PUT", "/api/admin/coach-users/c1/status", { status: "approved" }), 200);
    assert.equal(await send("POST", "/api/admin/set-coach-line-id", { coachUserId: "c1", lineId: "U-new-line" }), 200);
    const coachRows = auditRows.slice(2);
    assert.deepEqual(coachRows.map(r => r.action), ["coach.status", "coach.line_bind"]);
    assert.deepEqual([coachRows[0].before.status, coachRows[0].after.status], ["pending", "approved"]);
    const recorded = JSON.stringify(coachRows);
    for (const secret of [coach.lineId, "U-new-line", coach.phone, coach.email]) {
      assert.ok(!recorded.includes(secret), `audit must not store ${secret}`);
    }

    // The audit row belongs to the write: if it cannot be saved, neither is the change.
    setAuditWriterForTest(async () => { throw new Error("audit insert failed"); });
    assert.equal(await send("PUT", "/api/schedules/row", { expectedVersion: 1, className: "B班", coachName: null }), 500);
    assert.equal(await send("POST", "/api/schedules", { date: "2099-02-04", venueId: "v1", timeSlotId: "slot-3", className: "C班" }), 500);
  } finally {
    setAuditWriterForTest(collectAudit as never);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  await assert.rejects(
    recordAudit({ actor: "x", action: "schedule.update", entity: "schedule", entityId: "row" }),
    /inTransaction/,
  );
});

test("IT page: a LINE ID owned by another account is not a Ragic failure; LINE login and schools are actually checked", async () => {
  process.env.RAGIC_API_KEY ??= "test-key";
  const ragic = await import("./ragic");
  const { storage } = await import("./storage");
  const { lineLoginHealth, schoolModuleHealth } = await import("./modules/itGovernance.routes");
  const LINE = "U" + "fedcba9876543210".repeat(2);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const body = String(url).includes("general-information/23")
      ? { "31": { _ragicId: 31, 姓名: "已有帳號", 應徵職務: "教練" } }
      : String(url).includes("ragicforms4/20004")
        ? { "41": { _ragicId: 41, 姓名: "已有帳號", "個人LINE ID": LINE } }
        : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  Object.assign(storage, {
    getVenues: async () => [],
    getAllVenueInfos: async () => [],
    getAllCoachUsers: async () => [
      { id: "owner", name: "別人", status: "approved", lineId: LINE, employeeId: null, createdAt: new Date(0) },
      { id: "me", name: "已有帳號", status: "approved", lineId: null, employeeId: null, createdAt: new Date(0) },
    ],
    updateCoachUserLineId: async () => { throw new Error("must not rebind a LINE ID owned by someone else"); },
  });
  const outcomes: { status: string; failures: unknown[] }[] = [];
  ragic.setRagicRunStoreForTest({ start: async () => "run", finish: async (_id, outcome) => { outcomes.push(outcome); } });
  ragic.setRagicSyncLockForTest(async () => ({ release: async () => {} }));
  try {
    await ragic.syncRagicAll("manual");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual([outcomes.at(-1)!.status, outcomes.at(-1)!.failures.length], ["success", 0]);
  assert.equal(ragic.getRagicSyncStatus().lastError, null, "the Ragic chip must not turn red for this");

  const now = new Date("2026-10-15T00:00:00Z");
  assert.equal(lineLoginHealth({ configured: false, lastLoginAt: null, now }).status, "misconfigured");
  assert.equal(lineLoginHealth({ configured: true, lastLoginAt: null, now }).status, "unknown");
  assert.equal(lineLoginHealth({ configured: true, lastLoginAt: new Date("2026-10-14T13:00:00Z"), now }).status, "ok");
  assert.equal(lineLoginHealth({ configured: true, lastLoginAt: new Date("2026-08-01T00:00:00Z"), now }).status, "unknown");
  assert.equal(schoolModuleHealth({ enabled: true, schemas: [{ code: "demo", ready: true }, { code: "school1", ready: true }], now }).status, "ok");
  const broken = schoolModuleHealth({ enabled: true, schemas: [{ code: "demo", ready: true }, { code: "school1", ready: false }], now });
  assert.deepEqual([broken.status, broken.code], ["error", "missing_schema:school1"]);
  assert.equal(schoolModuleHealth({ enabled: false, schemas: [], now }).status, "disabled");
});
