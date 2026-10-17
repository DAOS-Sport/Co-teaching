import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildDailyNotifications, enqueueDailyNotifications, parseDailyTargetDate } from "./daily-plan";
import { notificationBatchMayContinue } from "./notification-batch";

function fixture(count = 400) {
  const coaches = Array.from({ length: count }, (_, n) => ({ id: `synthetic-account-${n}`, name: `synthetic-coach-${n}`, linkedCoachName: null, lineId: `synthetic-line-${n}` }));
  const schedules = coaches.map((coach, n) => ({ coachName: coach.name, coachName2: null, coach1IsTeaching: true, coach2IsTeaching: false, className: `synthetic-class-${n}`, venue: { name: "synthetic-venue" }, timeSlot: { order: 1, startTime: "09:00", endTime: "10:00" } }));
  const identity = (purpose: string, values: unknown[]) => createHash("sha256").update(JSON.stringify([purpose, ...values])).digest("hex");
  const plan = () => buildDailyNotifications("2026-10-18", { coaches, schedules, portalUrl: "https://example.invalid/coach-portal", notificationIdentity: identity, isRealCoachName: (value: unknown): value is string => typeof value === "string" && value.length > 0 });
  const enqueued: any[] = [];
  const deps = {
    findSavedTextNotification: async (_id: string): Promise<object | null> => null,
    dailyLogAlreadyExists: async (_name: string, _date: string) => false,
    enqueueTextNotification: async (input: any) => { enqueued.push(input); return { state: "pending" }; },
  };
  return { coaches, schedules, identity, plan, enqueued, deps };
}

test("daily plan has explicit valid date, legacy identity and frozen message; no Date.now dependency", () => {
  const f = fixture(1), plan = f.plan();
  assert.equal(plan.targetDate, "2026-10-18");
  assert.equal(plan.entries[0].kind, "notification");
  if (plan.entries[0].kind !== "notification") return;
  assert.equal(plan.entries[0].notificationId, f.identity("daily-reminder", ["2026-10-18", f.coaches[0].id]));
  assert.match(plan.entries[0].text, /10\/18\(日\)/);
  f.schedules[0].className = "mutated-source";
  assert.doesNotMatch(plan.entries[0].text, /mutated-source/);
  for (const bad of ["2026-02-30", "2026-1-18", "2026-10-18T00:00:00Z", "", "0000-01-01"]) {
    assert.throws(() => buildDailyNotifications(bad, { coaches: [], schedules: [], portalUrl: "", notificationIdentity: f.identity, isRealCoachName: (_: unknown): _ is string => false }), /invalid_daily_target_date/);
  }
});

test('expired frozen plan resumes saved identities but refuses every new historical delivery',async()=>{
  const f=fixture(2),plan=f.plan();
  const saved=(plan.entries[0] as any).notificationId;
  const result=await enqueueDailyNotifications(plan,{...f.deps,findSavedTextNotification:async(id)=>id===saved?{}:null},
    {now:()=>200,latestCreateAt:100,limit:2});
  assert.equal(result.queued,1);assert.equal(result.unknown,1);assert.equal(result.complete,true);
  assert.deepEqual(f.enqueued.map(x=>x.notificationId),[saved]);
});
test('legacy lookup crossing midnight rechecks admission before enqueue',async()=>{
  const f=fixture(1);let now=99;
  const result=await enqueueDailyNotifications(f.plan(),{...f.deps,dailyLogAlreadyExists:async()=>{now=101;return false;}},{now:()=>now,latestCreateAt:100});
  assert.equal(result.unknown,1);assert.equal(f.enqueued.length,0);
});

test("400 daily recipients enqueue in two checkpointed steps with zero send and fixed targetDate", async () => {
  const f = fixture(), plan = f.plan();
  const first = await enqueueDailyNotifications(plan, f.deps, { limit: 200 });
  const serialized = JSON.parse(JSON.stringify(plan));
  const second = await enqueueDailyNotifications(serialized, f.deps, { limit: 200, cursor: first.nextCursor });
  assert.equal(first.queued, 200); assert.equal(first.complete, false);
  assert.equal(second.queued, 200); assert.equal(second.complete, true);
  assert.equal(new Set(f.enqueued.map(row => row.notificationId)).size, 400);
  assert.ok(f.enqueued.every(row => row.reuseSavedPayload === true));
  assert.ok(f.enqueued.every(row => plan.entries.some(entry => entry.kind === "notification" && entry.notificationId === row.notificationId && entry.text === row.text)));
});

test("legacy untracked log is unknown and creates no fresh delivery identity", async () => {
  const f = fixture(1); f.deps.dailyLogAlreadyExists = async () => true;
  const result = await enqueueDailyNotifications(f.plan(), f.deps);
  assert.equal(result.unknown, 1); assert.equal(result.queued, 0); assert.equal(result.complete, true);
  assert.equal(f.enqueued.length, 0);
  f.deps.findSavedTextNotification = async () => ({ id: "original-saved-recipient" });
  const recovered = await enqueueDailyNotifications(f.plan(), f.deps);
  assert.equal(recovered.queued, 1, "original saved identity may be resumed despite compatibility log");
});

test("ambiguous account name fails closed, including duplicate account without LINE", async () => {
  const f = fixture(1); f.coaches.push({ ...f.coaches[0], id: "other-account", lineId: "" });
  const plan = f.plan(), result = await enqueueDailyNotifications(plan, f.deps);
  assert.equal(plan.entries[0].kind, "blocked");
  assert.equal(result.ambiguous, 1); assert.equal(result.queued, 0); assert.equal(f.enqueued.length, 0);
});

test("abort after in-flight enqueue finishes stops subsequent units and exposes exact cursor", async () => {
  const f = fixture(3), controller = new AbortController();
  let finished = false;
  f.deps.enqueueTextNotification = async input => { controller.abort(); await Promise.resolve(); f.enqueued.push(input); finished = true; return { state: "pending" }; };
  const result = await enqueueDailyNotifications(f.plan(), f.deps, { signal: controller.signal, limit: 3 });
  assert.equal(finished, true); assert.equal(result.queued, 1); assert.equal(result.nextCursor, 1); assert.equal(result.complete, false);
});

test("dry run calls no enqueue or legacy DB dependencies, expired budget calls none", async () => {
  const f = fixture(3);
  f.deps.findSavedTextNotification = async () => { throw new Error("must not read"); };
  const result = await enqueueDailyNotifications(f.plan(), f.deps, { dryRun: true, limit: 3 });
  assert.equal(result.complete, true); assert.equal(result.queued, 0); assert.equal(result.previewed, 3);
  assert.equal((await enqueueDailyNotifications(f.plan(), f.deps, { deadlineMs: 20, now: () => 20 })).visited, 0);
});

test("abort during saved lookup does not start legacy lookup or enqueue", async () => {
  const f = fixture(1), controller = new AbortController();
  f.deps.findSavedTextNotification = async () => { controller.abort(); return null; };
  f.deps.dailyLogAlreadyExists = async () => { throw new Error("must not read legacy after abort"); };
  const result = await enqueueDailyNotifications(f.plan(), f.deps, { signal: controller.signal });
  assert.equal(result.visited, 0); assert.equal(result.nextCursor, 0); assert.equal(f.enqueued.length, 0);
});

test("unconfigured queue rejects rather than acknowledging a lost daily entry", async () => {
  const f = fixture(1);
  f.deps.enqueueTextNotification = async () => ({ state: "not_configured" });
  await assert.rejects(enqueueDailyNotifications(f.plan(), f.deps), /daily_notification_queue_not_configured/);
});

function lineFunction(name: string, globals: Record<string, unknown>) {
  // Only the requested AST declaration is evaluated; unrelated personnel literals are never printed.
  const source = readFileSync(new URL("../../line-notify.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("line-notify.ts", source, ts.ScriptTarget.ES2022, true);
  const node = ast.statements.find((entry): entry is ts.FunctionDeclaration => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
  assert.ok(node, `missing ${name}`);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source.slice(node.getStart(ast), node.end) + `\nmodule.exports=${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Date, console: { log() {}, error() {} }, ...globals }, { timeout: 5000 });
  return module.exports as (...args: any[]) => Promise<any>;
}

test("line adapter prepares only the supplied date and does not read coaches after abort", async () => {
  const f = fixture(1), reads: unknown[][] = [], controller = new AbortController();
  const prepare = lineFunction("prepareDailyNotifications", {
    parseDailyTargetDate, notificationBatchMayContinue, buildDailyNotifications,
    storage: { getSchedulesByDateRange: async (...args: unknown[]) => { reads.push(args); return f.schedules; }, getApprovedCoachUsers: async () => f.coaches },
    coachPortalUrl: () => "https://example.invalid/coach-portal", notificationIdentity: f.identity, isRealCoachName: (value: unknown) => typeof value === "string" && value.length > 0,
  });
  const plan = await prepare("2026-10-18", { now: () => Date.parse("2026-10-18T00:10:00+08:00") });
  assert.equal(plan.targetDate, "2026-10-18", "same-day delayed execution keeps saved target rather than calculating a new tomorrow");
  assert.deepEqual(reads, [["2026-10-18", "2026-10-18"]]);
  await assert.rejects(prepare("2026-02-30"), /invalid_daily_target_date/);
  assert.equal(reads.length, 1);
  const aborting = lineFunction("prepareDailyNotifications", {
    parseDailyTargetDate, notificationBatchMayContinue, buildDailyNotifications,
    storage: { getSchedulesByDateRange: async () => { controller.abort(); return f.schedules; }, getApprovedCoachUsers: async () => { throw new Error("must not read coaches"); } },
  });
  await assert.rejects(aborting("2026-10-18", { signal: controller.signal }), /daily_preparation_interrupted/);
});

test("line adapter wet missing token fails before any queue read; dry run remains enqueue-only", async () => {
  const f = fixture(1);
  let entered = false;
  const adapter = lineFunction("enqueuePreparedDailyNotifications", {
    process: { env: {} },
    enqueueDailyNotifications: async (_plan: unknown, deps: Record<string, unknown>, options: unknown) => { entered = true; assert.deepEqual(Object.keys(deps).sort(), ["dailyLogAlreadyExists", "enqueueTextNotification", "findSavedTextNotification"]); return options; },
    findSavedTextNotification: f.deps.findSavedTextNotification, dailyLogAlreadyExists: f.deps.dailyLogAlreadyExists, enqueueTextNotification: f.deps.enqueueTextNotification,
  });
  await assert.rejects(adapter(f.plan()), /daily_line_token_not_configured/);
  assert.equal(entered, false);
  const result = await adapter(f.plan(), { dryRun: true, limit: 1 });
  assert.equal(result.dryRun, true); assert.equal(entered, true); assert.equal(f.enqueued.length, 0);
});

test("frozen daily message and identity match the original daily formatter for the same synthetic date", async () => {
  const f = fixture(1), sent: any[] = [];
  const fixedNow = Date.parse("2026-10-17T11:00:00.000Z");
  class FrozenDate extends Date { static now() { return fixedNow; } }
  const original = lineFunction("sendDailyTomorrowNotifications", {
    Date: FrozenDate, process: { env: { LINE_CHANNEL_ACCESS_TOKEN: "synthetic-only" } },
    storage: { getSchedulesByDateRange: async () => f.schedules, getApprovedCoachUsers: async () => f.coaches },
    isRealCoachName: (value: unknown) => typeof value === "string" && value.length > 0,
    notificationIdentity: f.identity, findSavedTextNotification: async () => null, dailyLogAlreadyExists: async () => false,
    coachPortalUrl: () => "https://example.invalid/coach-portal",
    sendDurableText: async (input: unknown) => { sent.push(input); return { accepted: false, state: "synthetic-no-transport" }; },
  });
  await assert.rejects(original(), /daily_notifications_incomplete_or_unknown/);
  const entry = f.plan().entries[0]; assert.equal(entry.kind, "notification");
  if (entry.kind !== "notification") return;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, entry.text);
  assert.equal(sent[0].notificationId, entry.notificationId);
  assert.equal(sent[0].to, entry.to);
});
