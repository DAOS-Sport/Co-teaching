import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  coachAvailabilityDtoSchema, coachUserDtoSchema, dateOnlySchema, jsonTimestampSchema, jsonValueSchema,
  scheduleDtoSchema, scheduleWithRelationsDtoSchema, teacherFeedbackDtoSchema, timeSlotDtoSchema,
  userDtoSchema, venueDtoSchema, venueInfoDtoSchema, weeklyPushRecipientDtoSchema,
  weeklyPushRunDetailResponseDtoSchema, weeklyPushRunDtoSchema, weeklyPushRunsResponseDtoSchema,
} from "../shared/contracts";
import { checkClientContracts } from "../tools/check-client-contracts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timestamp = "2026-10-17T01:02:03.000Z";
const venue = { id: "synthetic-venue", name: "Synthetic venue", color: "blue", order: 1 };
const timeSlot = { id: "synthetic-slot", period: "Synthetic period", startTime: "08:00", endTime: "09:00", order: 1 };
const schedule = {
  id: "synthetic-schedule", date: "2026-10-17", venueId: venue.id, timeSlotId: timeSlot.id,
  className: null, coachName: "Synthetic coach", coachName2: null, coach1IsTeaching: true,
  coach2IsTeaching: false, coachCount: 1, isClassLocked: false, notes: null,
  createdAt: timestamp, updatedAt: null, version: 7,
};
const run = {
  id: "synthetic-run", pushType: "weekly", weekStartDate: "2026-10-12", weekEndDate: "2026-10-18",
  triggerSource: "manual", destination: "synthetic-destination", idempotencyKey: "synthetic-idempotency",
  status: "queued", dryRun: true, startedAt: null, completedAt: null, totalCount: 1,
  successCount: 0, failureCount: 0, skippedCount: 0, reportPath: null, errorMessage: null,
  createdAt: timestamp, updatedAt: timestamp,
};
const recipient = {
  id: "synthetic-recipient", runId: run.id, recipientType: "coach", recipientId: null,
  recipientName: "Synthetic coach", lineUserId: null, status: "unknown", deliveryKey: "synthetic-delivery",
  lineRetryKey: "synthetic-retry", attemptCount: 1, startedAt: timestamp, completedAt: null, nextRetryAt: null,
  sentAt: null, lineResponseCode: null, errorCode: null, errorMessage: null,
  payloadJson: { messages: [{ type: "text", text: "Synthetic message" }], metadata: { accepted: false } },
  createdAt: timestamp, updatedAt: timestamp,
};

test("schedule contract accepts serialized HTTP JSON with relations and preserves extra response fields", () => {
  const raw = JSON.parse(JSON.stringify({ ...schedule, createdAt: new Date(timestamp), venue, timeSlot, extraReceipt: "synthetic" }));
  const parsed = scheduleWithRelationsDtoSchema.parse(raw);
  assert.deepEqual(parsed, raw);
  assert.equal(typeof parsed.createdAt, "string");
  assert.equal(parsed.updatedAt, null);
  assert.equal(parsed.version, 7);
  assert.equal(parsed.venue.id, raw.venueId);
});

test("wire timestamps and calendar dates reject Date instances, numbers and impossible dates", () => {
  for (const invalid of [new Date(timestamp), 1792198923000, "not-a-timestamp"]) assert.equal(jsonTimestampSchema.safeParse(invalid).success, false);
  assert.equal(jsonTimestampSchema.safeParse("2026-10-17T09:02:03+08:00").success, true);
  for (const invalid of ["2026-02-29", "2026-13-01", "2026-4-01", "2026-10-17T00:00:00.000Z", new Date(timestamp)]) assert.equal(dateOnlySchema.safeParse(invalid).success, false);
  assert.equal(dateOnlySchema.safeParse("2024-02-29").success, true);
  assert.equal(scheduleDtoSchema.safeParse({ ...schedule, createdAt: new Date(timestamp) }).success, false);
});

test("nullable response fields remain required and scalar types are not coerced", () => {
  const missing = { ...schedule } as Partial<typeof schedule>;
  delete missing.notes;
  assert.equal(scheduleDtoSchema.safeParse(missing).success, false);
  assert.equal(scheduleDtoSchema.safeParse({ ...schedule, coachCount: "1" }).success, false);
  assert.equal(scheduleDtoSchema.safeParse({ ...schedule, version: 1.5 }).success, false);
  assert.equal(scheduleDtoSchema.safeParse({ ...schedule, coach1IsTeaching: "false" }).success, false);
  assert.deepEqual(scheduleDtoSchema.parse({ ...schedule, notes: "" }), { ...schedule, notes: "" });
});

test("account, availability, venue info and feedback samples preserve nullable fields and open status values", () => {
  const account = { id: "synthetic-user", email: null, firstName: null, lastName: null, profileImageUrl: null, role: "future-role", coachName: null, createdAt: null, updatedAt: timestamp };
  const coach = { id: "synthetic-coach", lineId: null, name: "Synthetic coach", phone: null, email: null, employeeId: null, status: "future-status", role: "coach", linkedCoachName: null, createdAt: timestamp, updatedAt: null };
  const availability = { id: "synthetic-availability", coachName: coach.name, weekStart: "2026-10-12", dayOfWeek: 1, timeSlotOrder: 2, createdAt: null };
  const info = { id: "synthetic-info", venueName: venue.name, videoUrl: null, description: "", mapUrl: null, updatedAt: timestamp };
  const feedback = { id: "synthetic-feedback", scheduleId: schedule.id, teacherId: null, teacherName: "Synthetic teacher", status: "future-status", rescheduleDate: null, reschedulePeriod: null, comment: null, updatedAt: timestamp };
  for (const [schema, sample] of [[userDtoSchema, account], [coachUserDtoSchema, coach], [coachAvailabilityDtoSchema, availability], [venueInfoDtoSchema, info], [teacherFeedbackDtoSchema, feedback]] as const) assert.deepEqual(schema.parse(sample), sample);
});

test("notification responses retain stable keys, unknown delivery state, JSON payload and nullable receipts", () => {
  assert.deepEqual(weeklyPushRunsResponseDtoSchema.parse({ runs: [run], extension: true }), { runs: [run], extension: true });
  const detail = { run, recipients: [recipient], extension: "synthetic" };
  assert.deepEqual(weeklyPushRunDetailResponseDtoSchema.parse(detail), detail);
  assert.equal(weeklyPushRunDetailResponseDtoSchema.safeParse({ run, recipients: [{ ...recipient, sentAt: new Date(timestamp) }] }).success, false);
  assert.equal(jsonValueSchema.safeParse({ invalid: undefined }).success, false);
  assert.equal(jsonValueSchema.safeParse({ invalid: Infinity }).success, false);
  assert.deepEqual(jsonValueSchema.parse({ array: [null, true, 1, "synthetic"] }), { array: [null, true, 1, "synthetic"] });
});

test("contract row parsers preserve every existing response row field independently of ORM inference", async () => {
  const source = await readFile(path.join(repoRoot, "shared/schema.ts"), "utf8");
  const ast = ts.createSourceFile("schema.ts", source, ts.ScriptTarget.Latest, true);
  const tableFields = new Map<string, string[]>();
  for (const node of ast.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const properties = declaration.initializer.arguments[1];
      if (!properties || !ts.isObjectLiteralExpression(properties)) continue;
      tableFields.set(declaration.name.text, properties.properties.flatMap((property) => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? [property.name.text] : []));
    }
  }
  for (const [table, validator] of [
    ["venues", venueDtoSchema], ["timeSlots", timeSlotDtoSchema], ["schedules", scheduleDtoSchema],
    ["users", userDtoSchema], ["coachUsers", coachUserDtoSchema], ["coachAvailability", coachAvailabilityDtoSchema],
    ["venueInfos", venueInfoDtoSchema], ["teacherFeedbacks", teacherFeedbackDtoSchema],
    ["weeklyPushRuns", weeklyPushRunDtoSchema], ["weeklyPushRecipients", weeklyPushRecipientDtoSchema],
  ] as const) assert.deepEqual(Object.keys(validator.shape).sort(), tableFields.get(table)?.sort(), table);
});

// Keep each tiny synthetic source fixture as reproducible checker evidence.
// These contain no user data; no project cleanup or background process is used.
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "ct-b2-contracts-"));
let fixtureId = 0;
async function fixture(files: Record<string, string>, extraPaths: Record<string, string[]> = {}) {
  const root = path.join(fixtureRoot, String(++fixtureId));
  const contents = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "bundler", module: "esnext", paths: { "@/*": ["client/src/*"], "@shared/*": ["shared/*"], ...extraPaths } }, include: ["client/src/**/*", "shared/**/*"] }),
    "shared/schema.ts": "export interface Record { id: string }",
    ...files,
  };
  for (const [name, content] of Object.entries(contents)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return checkClientContracts(root);
}

test("client source dependency gate passes the real local import closure", async () => {
  const result = await checkClientContracts(repoRoot);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(result.roots > 0);
  assert.ok(result.files >= result.roots);
});

test("gate accepts pure DTO reexports, local aliases and static dynamic imports", async () => {
  const result = await fixture({
    "client/src/main.ts": 'import type { Record } from "@shared/contracts"; void import("@/lazy"); export type View = Record;',
    "client/src/lazy.ts": 'export { type Record } from "@shared/contracts";',
    "shared/contracts/index.ts": 'export type { Record } from "./dto";',
    "shared/contracts/dto.ts": 'export interface Record { id: string; createdAt: string | null }',
  });
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

const rejected = [
  ["direct type-only schema import", { "client/src/main.ts": 'import type { Record } from "@shared/schema"; export type View = Record;' }, "SCHEMA_DEPENDENCY"],
  ["indirect type reexport", { "client/src/main.ts": 'import type { Record } from "@shared/bridge";', "shared/bridge.ts": 'export type { Record } from "./schema";' }, "SCHEMA_DEPENDENCY"],
  ["namespace reexport", { "client/src/main.ts": 'export * as Models from "@shared/bridge";', "shared/bridge.ts": 'export * from "./schema";' }, "SCHEMA_DEPENDENCY"],
  ["static dynamic schema import", { "client/src/main.ts": 'void import("@shared/schema");' }, "SCHEMA_DEPENDENCY"],
  ["transitive dynamic dependency", { "client/src/main.ts": 'void import("@shared/lazy");', "shared/lazy.ts": 'import { sql } from "drizzle-orm"; export { sql };' }, "DRIZZLE_DEPENDENCY"],
  ["TypeScript import type", { "client/src/main.ts": 'export type View = import("@shared/schema").Record;' }, "SCHEMA_DEPENDENCY"],
  ["typeof import cannot disguise a schema contract", { "client/src/main.ts": 'export type View = typeof import("@shared/schema");' }, "SCHEMA_DEPENDENCY"],
  ["CommonJS require", { "client/src/main.ts": 'const model = require("@shared/schema");' }, "SCHEMA_DEPENDENCY"],
  ["TypeScript import equals require", { "client/src/main.ts": 'import Models = require("@shared/schema");' }, "SCHEMA_DEPENDENCY"],
  ["Drizzle subpath type export", { "client/src/main.ts": 'export type { PgTable } from "drizzle-orm/pg-core";' }, "DRIZZLE_DEPENDENCY"],
  ["drizzle-zod reexport", { "client/src/main.ts": 'export { createInsertSchema } from "drizzle-zod";' }, "DRIZZLE_DEPENDENCY"],
  ["computed dynamic import", { "client/src/main.ts": 'const suffix = "schema"; void import("@shared/" + suffix);' }, "DYNAMIC_DEPENDENCY"],
  ["Vite import glob", { "client/src/main.ts": 'const modules = import.meta.glob("../../shared/*.ts");' }, "DYNAMIC_DEPENDENCY"],
  ["triple slash local reference", { "client/src/main.ts": '/// <reference path="../../shared/schema.ts" />\nexport {};' }, "SCHEMA_DEPENDENCY"],
  ["unresolved local module", { "client/src/main.ts": 'export * from "./missing";' }, "UNRESOLVED_LOCAL_DEPENDENCY"],
] as const;
for (const [name, files, code] of rejected) test(`gate rejects ${name}`, async () => {
  const result = await fixture(files);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item: { code: string }) => item.code === code), JSON.stringify(result.violations));
});

test("gate resolves custom tsconfig aliases before applying the schema boundary", async () => {
  const result = await fixture({ "client/src/main.ts": 'import type { Record } from "#record";' }, { "#record": ["shared/schema.ts"] });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item: { code: string }) => item.code === "SCHEMA_DEPENDENCY"));
});

test("gate rejects a declared transitive Drizzle dependency hidden behind a package", async () => {
  const result = await fixture({
    "client/src/main.ts": 'import type { Record } from "browser-wire";',
    "node_modules/browser-wire/package.json": JSON.stringify({ name: "browser-wire", types: "index.d.ts", dependencies: { "bridge-wire": "1.0.0" } }),
    "node_modules/browser-wire/index.d.ts": 'export interface Record { id: string }',
    "node_modules/bridge-wire/package.json": JSON.stringify({ name: "bridge-wire", types: "index.d.ts", dependencies: { "drizzle-orm": "1.0.0" } }),
    "node_modules/bridge-wire/index.d.ts": 'export interface Record { id: string }',
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item: { code: string }) => item.code === "TRANSITIVE_DRIZZLE_PACKAGE"));
});

test("gate parses package declaration reexports even when the manifest omits Drizzle", async () => {
  const result = await fixture({
    "client/src/main.ts": 'import type { Record } from "browser-wire";',
    "node_modules/browser-wire/package.json": JSON.stringify({ name: "browser-wire", types: "index.d.ts" }),
    "node_modules/browser-wire/index.d.ts": 'export type { Record } from "./hidden";',
    "node_modules/browser-wire/hidden.d.ts": 'export type { SQL as Record } from "drizzle-orm";',
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item: { code: string }) => item.code === "DRIZZLE_DEPENDENCY"));
});

test("gate follows triple slash package type references to hidden schema dependencies", async () => {
  const result = await fixture({
    "client/src/main.ts": '/// <reference types="browser-wire" />\nexport {};',
    "node_modules/@types/browser-wire/package.json": JSON.stringify({ name: "@types/browser-wire", types: "index.d.ts" }),
    "node_modules/@types/browser-wire/index.d.ts": 'export type { SQL } from "drizzle-orm";',
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item: { code: string }) => item.code === "DRIZZLE_DEPENDENCY"));
});

test.after(() => console.info(JSON.stringify({ retainedSyntheticContractFixtures: fixtureRoot, count: fixtureId })));
