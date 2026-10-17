import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const serverDir = dirname(fileURLToPath(import.meta.url));

// Execute the real TypeScript module, but provide every external dependency.
// No database driver, credentials, timers or network client can escape this VM.
function loadModule(relativePath: string, stubs: Record<string, unknown>, env: Record<string, string> = {}) {
  const file = resolve(serverDir, relativePath);
  const source = readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} as any };
  const context = {
    module,
    exports: module.exports,
    process: { env: { ...env } },
    console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (name === "./startup-policy") return loadModule("infra/startup-policy.ts", {});
      throw new Error(`Unstubbed startup dependency: ${name}`);
    },
    setTimeout() { throw new Error("Unexpected startup timer"); },
    setInterval() { throw new Error("Unexpected startup interval"); },
  };
  vm.runInNewContext(compiled, context, { filename: file, timeout: 5_000 });
  return module.exports;
}

function startupFixture(failAt?: string) {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
    if (name === failAt) throw Object.assign(new Error("Synthetic maintenance failure"), { code: "SYNTHETIC_WRITE" });
  };
  const db = {
    update() {
      calls.push("db.update");
      if (failAt === "db.update") throw Object.assign(new Error("Synthetic maintenance failure"), { code: "SYNTHETIC_WRITE" });
      return { set: () => ({ where: () => ({ returning: async () => [] }) }) };
    },
  };
  const boss = { createQueue: record("boss.createQueue") };
  const exports = loadModule("infra/startup.ts", {
    "drizzle-orm": { and() {}, eq() {} },
    "../db": { db },
    "@shared/schema": { coachUsers: {}, venues: {} },
    "../storage": { storage: { initializeVenues: record("seed.venues"), initializeTimeSlots: record("seed.timeSlots") } },
    "../multi-school-db": { initializeSchoolSchema: record("schema.initialize"), getAvailableSchools: () => ["demo"] },
    "../config/env": { env: { isDeployment: true, databaseUrl: "synthetic", healthchecksWeeklyPushUrl: "synthetic", healthchecksWeeklyPushEnabled: true }, validateConfig() {} },
    "../config/featureFlags": { featureFlags: { enableSchoolModule: true, enableWeeklyPushQueue: true, enableWeeklyPushWorker: true } },
    "node-cron": { schedule: record("cron.schedule") },
    "./queue/runtime": { startNotificationRuntime: record("boss.start") },
    "./queue/queues": { queues: { weeklyPush: "synthetic-main", weeklyPushRecipient: "synthetic-recipient", weeklyPushReport: "synthetic-report" } },
    "../config/lineGroups": { lineGroups: { itGroupId: "synthetic" } },
    "../modules/weeklyPush/weeklyPush.worker": { startWeeklyPushWorkers: record("workers.start") },
    "../modules/weeklyPush/weeklyPush.service": { enqueueWeeklyPush: record("enqueue") },
    "../modules/weeklyPush/weeklyPush.reconcile": { setupWeeklyPushReconciliation: record("reconcile.start") },
  });
  return { calls, exports };
}

test("boot policy grants no write, job or pruning permission even with feature envs present", () => {
  const { startupPolicy } = loadModule("infra/startup-policy.ts", {}, {
    FEATURE_WEEKLY_PUSH_QUEUE: "true", FEATURE_WEEKLY_PUSH_WORKER: "true", REPLIT_DEPLOYMENT: "1",
  });
  assert.equal(Object.isFrozen(startupPolicy), true);
  assert.deepEqual(JSON.parse(JSON.stringify(startupPolicy)), { databaseMaintenance: false, backgroundJobs: false, sessionPruning: false });
});

for (const name of ["runStartupFixes", "initializeAppData", "startWeeklyPushQueue"]) {
  test(`${name} requires an explicit maintenance invocation before any effect`, async () => {
    const fixture = startupFixture();
    await assert.rejects(fixture.exports[name](), { code: "MAINTENANCE_REQUIRED" });
    assert.deepEqual(fixture.calls, []);
    await assert.rejects(fixture.exports[name]({ mode: "startup" }), { code: "MAINTENANCE_REQUIRED" });
    assert.deepEqual(fixture.calls, []);
  });
}

test("explicit maintenance retains seed and repair operations", async () => {
  const fixture = startupFixture();
  await fixture.exports.runStartupFixes({ mode: "maintenance" });
  await fixture.exports.initializeAppData({ mode: "maintenance" });
  assert.deepEqual(fixture.calls, ["db.update", "db.update", "seed.venues", "seed.timeSlots", "schema.initialize"]);
});

for (const [name, failAt] of [["runStartupFixes", "db.update"], ["initializeAppData", "schema.initialize"], ["startWeeklyPushQueue", "boss.start"]]) {
  test(`${name} propagates explicit maintenance failures`, async () => {
    const fixture = startupFixture(failAt);
    await assert.rejects(fixture.exports[name]({ mode: "maintenance" }), { code: "SYNTHETIC_WRITE" });
  });
}

function schoolFixture(options: { exists?: boolean; readFailure?: boolean } = {}) {
  const statements: string[] = [];
  const pools: { options: any; ended: boolean }[] = [];
  class Pool {
    record: typeof pools[number];
    constructor(poolOptions: unknown) {
      this.record = { options: poolOptions, ended: false };
      pools.push(this.record);
    }
    async end() { this.record.ended = true; }
  }
  const sql: any = (parts: TemplateStringsArray) => parts.join("?");
  sql.identifier = (name: string) => name;
  const exports = loadModule("multi-school-db.ts", {
    "@neondatabase/serverless": { Pool, neonConfig: {} },
    "drizzle-orm/neon-serverless": {
      drizzle: () => ({
        async execute(statement: string) {
          const operation = statement.trim().split(/\s+/)[0].toUpperCase();
          statements.push(operation);
          if (/information_schema/.test(statement)) {
            if (options.readFailure) throw Object.assign(new Error("Synthetic read failure"), { code: "SYNTHETIC_READ" });
            return { rows: options.exists ? [{ schema_name: "synthetic" }] : [] };
          }
          return { rows: [{ count: "1" }] };
        },
      }),
    },
    "drizzle-orm": { sql },
    ws: {},
    "@shared/schema": {},
  }, { DATABASE_URL: "postgresql://synthetic.invalid/synthetic" });
  return { exports, statements, pools };
}

test("school accessor checks an existing schema using only SELECT and caches it", async () => {
  const fixture = schoolFixture({ exists: true });
  const first = await fixture.exports.getSchoolDb("demo");
  assert.equal(await fixture.exports.getSchoolDb("demo"), first);
  assert.deepEqual(fixture.statements, ["SELECT"]);
  assert.equal(fixture.pools.length, 1);
  assert.equal(fixture.pools[0].options.options, "-c search_path=school_demo");
});

test("missing school schema fails without creating or seeding and closes its pool", async () => {
  const fixture = schoolFixture();
  await assert.rejects(fixture.exports.getSchoolDb("demo"), { code: "SCHOOL_SCHEMA_MISSING" });
  assert.deepEqual(fixture.statements, ["SELECT"]);
  assert.equal(fixture.pools.length, 1);
  assert.equal(fixture.pools[0].ended, true);
});

test("failed school schema read propagates a diagnostic failure without repair", async () => {
  const fixture = schoolFixture({ readFailure: true });
  await assert.rejects(fixture.exports.getSchoolDb("demo"), { code: "SCHOOL_SCHEMA_CHECK_FAILED" });
  assert.deepEqual(fixture.statements, ["SELECT"]);
  assert.equal(fixture.pools[0].ended, true);
});

test("manual school schema initialization remains a separate operation", async () => {
  const fixture = schoolFixture();
  await fixture.exports.initializeSchoolSchema("school1");
  assert.ok(fixture.statements.includes("CREATE"));
  assert.ok(fixture.statements.includes("ALTER"));
  assert.equal(fixture.pools[0].ended, true);
});

test("session store cannot create tables or schedule automatic pruning on boot", () => {
  const stores: any[] = [];
  const exports = loadModule("replitAuth.ts", {
    "openid-client": {},
    "openid-client/passport": {},
    passport: {},
    "express-session": (options: unknown) => options,
    memoizee: (fn: unknown) => fn,
    "connect-pg-simple": () => class { constructor(options: unknown) { stores.push(options); } },
    "./storage": { storage: {} },
  }, { REPLIT_DOMAINS: "synthetic.invalid", DATABASE_URL: "synthetic", SESSION_SECRET: "synthetic" });
  exports.getSession();
  assert.equal(stores.length, 1);
  assert.equal(stores[0].createTableIfMissing, false);
  assert.equal(stores[0].pruneSessionInterval, false);
});

test("registerRoutes contains no automatic maintenance or background start call", () => {
  const source = readFileSync(resolve(serverDir, "routes.ts"), "utf8");
  const parsed = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
  const forbidden = new Set(["runStartupFixes", "initializeAppData", "startWeeklyPushQueue", "setupDailyNotificationCron", "setupRagicSyncCron", "setupLogRetention", "setupReportCleanupCron"]);
  const found: { name: string; line: number }[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name && forbidden.has(name)) found.push({ name, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.deepEqual(found, [], `Automatic boot call graph; source SHA256 ${createHash("sha256").update(source).digest("hex")}`);
});
