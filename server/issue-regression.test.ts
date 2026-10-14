import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { logTimestamp } from "./shared/logTimestamp";

process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
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
    const res = await send(method, path, body);
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
