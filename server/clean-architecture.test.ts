import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkCoreBoundaries } from "../tools/check-clean-boundaries.mjs";

// The runner supplies a wholly synthetic environment. Never load dotenv here.
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
process.env.ADMIN_PASSWORD = "isolated-test-admin";
process.env.TEACHER_TOKEN_SECRET = "isolated-test-teacher-secret";
process.env.NODE_ENV = "test";
process.env.REPLIT_DEPLOYMENT = "0";

const { storage } = await import("./storage");
const { pool } = await import("./db");
const { setBaseDbForTest } = await import("./shared/dbContext");
const { setAuditWriterForTest } = await import("./shared/audit");
const { setSchedulingLocksForTest } = await import("./infrastructure/scheduling/composition");
const { ScheduleVersionConflictError } = await import("./repositories/schedule.repository");
const { callSchedulingTool } = await import("./mcp/schedulingTools");
const { registerScheduleRoutes } = await import("./modules/schedule.routes");
const express = (await import("express")).default;

const syntheticVenue = { id: "fixture-venue", name: "Synthetic Venue", color: "blue", order: 1 };
const syntheticSlot = { id: "fixture-slot", order: 3, period: "3", startTime: "10:00", endTime: "11:00" };

async function coreFixture(t: any, sources: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "co-teaching-core-gate-"));
  const core = path.join(directory, "core");
  await mkdir(core);
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  for (const [name, source] of Object.entries(sources)) {
    const filename = path.resolve(directory, name);
    assert.ok(filename.startsWith(directory + path.sep));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source, "utf8");
  }
  return { directory, core };
}

test("A1 boundary gate accepts pure internal static/reexport/dynamic/type imports and ignores text", async (t) => {
  const { core } = await coreFixture(t, {
    "core/main.ts": `import { value } from './barrel.js'; export type T = import('./types').T; export const load = () => import('./types'); export const text = 'process.env import("express")'; // require('node:fs')\nexport const result = value;`,
    "core/barrel.ts": `export { value } from './value';`,
    "core/value.ts": `const process = { env: { local: true } }; export const value = process.env.local;`,
    "core/types.ts": `export type T = { value: number };`,
  });
  const result = await checkCoreBoundaries(core);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.files, 4);
  // Type and dynamic imports target the same file; graph edges are unique.
  assert.equal(result.edges, 3);
});

const boundaryRejects: Array<[string, string, Record<string, string>]> = [
  ["external package", "EXTERNAL_IMPORT", { "core/main.ts": `import express from 'express'; export { express };` }],
  ["node builtin", "EXTERNAL_IMPORT", { "core/main.ts": `export * from 'node:fs';` }],
  ["bare builtin", "EXTERNAL_IMPORT", { "core/main.ts": `export { readFile } from 'fs';` }],
  ["ambient node Buffer", "RUNTIME_GLOBAL", { "core/main.ts": `export const value = Buffer.from('synthetic');` }],
  ["ambient network provider", "RUNTIME_GLOBAL", { "core/main.ts": `export const load = () => fetch('https://synthetic.invalid');` }],
  ["process dot env", "RUNTIME_GLOBAL", { "core/main.ts": `export const value = process.env.FLAG;` }],
  ["process computed env", "RUNTIME_GLOBAL", { "core/main.ts": `export const value = process['env']['FLAG'];` }],
  ["ambient process declaration", "RUNTIME_GLOBAL", { "core/main.ts": `declare const process: any; export const value = process.env.FLAG;` }],
  ["environment alias", "RUNTIME_GLOBAL", { "core/main.ts": `const runtime = process; const { env } = runtime; export { env };` }],
  ["global environment", "RUNTIME_GLOBAL", { "core/main.ts": `export const value = globalThis['process']['env'];` }],
  ["import meta environment", "RUNTIME_GLOBAL", { "core/main.ts": `export const value = import.meta.env.FLAG;` }],
  ["outside core", "OUTSIDE_CORE", { "core/main.ts": `import { value } from '../outer'; export { value };`, "outer.ts": `export const value = 1;` }],
  ["indirect reexport", "OUTSIDE_CORE", { "core/main.ts": `export * from './barrel';`, "core/barrel.ts": `export * from '../outer';`, "outer.ts": `export const value = 1;` }],
  ["type reexport", "EXTERNAL_IMPORT", { "core/main.ts": `export type { Request } from 'express';` }],
  ["dynamic external import", "EXTERNAL_IMPORT", { "core/main.ts": `export const load = () => import('drizzle-orm');` }],
  ["computed dynamic import", "DYNAMIC_DEPENDENCY", { "core/main.ts": `const target = './value'; export const load = () => import(target);`, "core/value.ts": `export const value = 1;` }],
  ["require package", "EXTERNAL_IMPORT", { "core/main.ts": `const adapter = require('express'); export { adapter };` }],
  ["computed require", "DYNAMIC_DEPENDENCY", { "core/main.ts": `const target = './value'; export const value = require(target);`, "core/value.ts": `export const value = 1;` }],
  ["require alias", "RUNTIME_GLOBAL", { "core/main.ts": `const load = require; export const value = load('node:fs');` }],
  ["import equals require", "EXTERNAL_IMPORT", { "core/main.ts": `import adapter = require('express'); export { adapter };` }],
  ["import type", "EXTERNAL_IMPORT", { "core/main.ts": `export type T = import('express').Request;` }],
  ["dependency cycle", "DEPENDENCY_CYCLE", { "core/a.ts": `export * from './b';`, "core/b.ts": `export * from './a';` }],
  ["unresolved internal import", "UNRESOLVED_IMPORT", { "core/main.ts": `export * from './missing';` }],
  ["type reference", "EXTERNAL_REFERENCE", { "core/main.ts": `/// <reference types="node" />\nexport const value = 1;` }],
  ["runtime code generation", "RUNTIME_GLOBAL", { "core/main.ts": `export const load = Function('return process.env');` }],
];
for (const [label, code, sources] of boundaryRejects) {
  test(`A1 boundary gate rejects ${label}`, async (t) => {
    const { core } = await coreFixture(t, sources);
    const result = await checkCoreBoundaries(core);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((violation: any) => violation.code === code), JSON.stringify(result));
  });
}

test("A1 boundary gate resolves symlink escapes before accepting dependencies", async (t) => {
  const { directory, core } = await coreFixture(t, {
    "core/main.ts": `export * from './linked/value';`,
    "outer/value.ts": `export const value = 1;`,
  });
  await symlink(path.join(directory, "outer"), path.join(core, "linked"), "junction");
  const result = await checkCoreBoundaries(core);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation: any) => violation.code === "OUTSIDE_CORE"));
});

test("A1 boundary gate rejects a substituted core root junction", async (t) => {
  const { directory, core } = await coreFixture(t, { "core/main.ts": `export const value = 1;` });
  const linkedRoot = path.join(directory, "substituted-core");
  await symlink(core, linkedRoot, "junction");
  const result = await checkCoreBoundaries(linkedRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation: any) => violation.code === "OUTSIDE_CORE"));
});

function makeRow(locked = false) {
  return {
    id: "fixture-row", date: "2099-01-07", venueId: syntheticVenue.id,
    timeSlotId: syntheticSlot.id, className: "Synthetic Class", coachName: null,
    coachName2: null, coachCount: 2, coach1IsTeaching: true,
    coach2IsTeaching: false, isClassLocked: locked, notes: null, version: 3,
    venue: syntheticVenue, timeSlot: syntheticSlot,
  };
}

/** Execute the actual registered route and admin middleware, without a socket/server. */
async function callRegisteredHttpRoute(routePath: string, body: object) {
  const app = express();
  registerScheduleRoutes(app);
  const layer = (app as any)._router.stack.find((item: any) =>
    item.route?.path === routePath && item.route.methods.put);
  assert.ok(layer, `actual PUT route must exist: ${routePath}`);
  const result = { status: 200, body: undefined as any };
  const response: any = {
    status(code: number) { result.status = code; return this; },
    json(value: unknown) { result.body = value; return this; },
    getHeader() { return undefined; },
  };
  const request: any = {
    method: "PUT", params: { id: "fixture-row" }, query: {}, body,
    headers: { "x-admin-password": "isolated-test-admin" }, res: response,
    get(name: string) { return this.headers[name.toLowerCase()]; },
  };
  const handlers = layer.route.stack;
  async function dispatch(index: number): Promise<void> {
    if (index === handlers.length) return;
    let continuation: Promise<void> | undefined;
    await handlers[index].handle(request, response, (error: unknown) => {
      if (error) throw error;
      continuation = dispatch(index + 1);
    });
    await continuation;
  }
  await dispatch(0);
  return result;
}

function isolateDependencies(t: any, locked = false) {
  const row: any = makeRow(locked);
  const writes: Array<{ id: string; patch: object; expectedVersion: unknown }> = [];
  const audits: unknown[] = [];
  const locks: string[][] = [];
  const rejectDatabaseAccess = async () => { throw new Error("isolated test must not access PostgreSQL"); };
  t.mock.method(pool, "query", rejectDatabaseAccess);
  t.mock.method(pool, "connect", rejectDatabaseAccess);
  const fakeDb: any = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
    execute: rejectDatabaseAccess,
  };
  setBaseDbForTest(fakeDb);
  setSchedulingLocksForTest({ acquire: async (keys) => { locks.push([...keys]); } });
  setAuditWriterForTest(async (entry) => { audits.push(entry); });
  t.after(() => { setBaseDbForTest(null); setAuditWriterForTest(null); setSchedulingLocksForTest(null); });
  const write = async (id: string, patch: object, expectedVersion?: number) => {
    if (expectedVersion !== undefined && expectedVersion !== row.version) throw new ScheduleVersionConflictError();
    writes.push({ id, patch: structuredClone(patch), expectedVersion });
    Object.assign(row, patch, { version: row.version + 1 });
    return structuredClone(row);
  };
  t.mock.method(storage, "getScheduleById", async (id: string) => id === row.id ? structuredClone(row) : undefined);
  t.mock.method(storage, "getSchedulesByDate", async () => [structuredClone(row)]);
  t.mock.method(storage, "getSchedulesByDateRange", async () => [structuredClone(row)]);
  t.mock.method(storage, "getVenues", async () => [syntheticVenue]);
  t.mock.method(storage, "getTimeSlots", async () => [syntheticSlot]);
  t.mock.method(storage, "getCoachAvailabilityByWeek", async () => []);
  t.mock.method(storage, "getApprovedCoachUsers", async () => [{ id: "fixture-coach", name: "Synthetic Coach", linkedCoachName: null, status: "approved" }]);
  t.mock.method(storage, "getConflicts", async () => []);
  t.mock.method(storage, "updateSchedule", write);
  t.mock.method(storage, "assignCoach", async (id: string, coachName: string | null, version?: number) => write(id, { coachName }, version));
  return { row, writes, audits, locks };
}

for (const entry of ["HTTP", "MCP"] as const) {
  for (const scenario of [
    { label: "missing", version: undefined, code: "VERSION_REQUIRED", status: 428 },
    { label: "stale", version: 2, code: "VERSION_CONFLICT", status: 409 },
  ]) {
    test(`A1 ${entry} ${scenario.label} expectedVersion refuses with zero business writes`, async (t) => {
      const fixture = isolateDependencies(t);
      const body = { className: "Synthetic Changed Class", coachName: null, ...(scenario.version === undefined ? {} : { expectedVersion: scenario.version }) };
      let code: unknown;
      let status: unknown;
      if (entry === "HTTP") {
        const result = await callRegisteredHttpRoute("/api/schedules/:id", body);
        code = result.body?.code;
        status = result.status;
      } else {
        try {
          const result: any = await callSchedulingTool("update_schedule", { scheduleId: fixture.row.id, ...body });
          code = result?.code;
        } catch (error: any) { code = error?.code; }
      }
      t.diagnostic(JSON.stringify({ entry, scenario: scenario.label, writes: fixture.writes.length, code: code ?? null, status: status ?? null }));
      assert.equal(fixture.writes.length, 0, "a missing/stale version must cause zero business writes");
      assert.equal(fixture.audits.length, 0, "a refused mutation must not add success audit");
      assert.equal(code, scenario.code);
      if (entry === "HTTP") assert.equal(status, scenario.status);
    });
  }
  test(`A1 ${entry} permits coach assignment on a locked class with current version`, async (t) => {
    const fixture = isolateDependencies(t, true);
    const body = { coachName: "Synthetic Coach", expectedVersion: fixture.row.version };
    const result: any = entry === "HTTP"
      ? await callRegisteredHttpRoute("/api/schedules/:id/assign-coach", body)
      : await callSchedulingTool("update_schedule", { scheduleId: fixture.row.id, ...body });
    if (entry === "HTTP") assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].expectedVersion, 3);
    assert.equal(fixture.row.coachName, "Synthetic Coach");
    assert.equal(fixture.row.isClassLocked, true);
    assert.equal(fixture.audits.length, 1);
  });
}
