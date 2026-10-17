import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./modules/weeklyPush/weeklyPush.worker.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("weeklyPush.worker.ts", source, ts.ScriptTarget.Latest, true);

function loadHandler(name: string, dependencies: Record<string, unknown>) {
  const declaration = sourceFile.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, `actual worker handler ${name} must exist`);
  const constants = sourceFile.statements.flatMap((node) => ts.isVariableStatement(node)
    ? node.declarationList.declarations.filter((item) => ts.isIdentifier(item.name) && item.initializer && ts.isStringLiteral(item.initializer))
      .map((item) => source.slice(item.getStart(sourceFile), item.end)) : []);
  const finalizer = sourceFile.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "finalizeWeeklyPushRun");
  const code = ts.transpileModule(
    `${constants.map((item) => `const ${item};`).join("\n")}\n${finalizer ? source.slice(finalizer.getStart(sourceFile), finalizer.end).replace(/^export\s+/, "") : ""}\nconst handler = (${source.slice(declaration.getStart(sourceFile), declaration.end).replace(/^export\s+/, "")});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn handler;`)(...Object.values(dependencies)) as (jobs: unknown[]) => Promise<void>;
}

function fixture(options: {
  counts?: Partial<Record<"total" | "success" | "failed" | "skipped" | "pending" | "sending" | "retryWait" | "unknown", number>>;
  missingRun?: boolean;
  retry?: boolean;
  reportError?: boolean;
  summaryError?: boolean;
  missingFinalRun?: boolean;
  dryRun?: boolean;
  summaryStatus?: "accepted" | "unknown" | "failed" | "not_configured";
  summaryConfigured?: number;
  deliverState?: "accepted" | "unclaimed";
  existingRecipientStatus?: string;
  failurePatchError?: boolean;
} = {}) {
  const events: string[] = [];
  const failures: unknown[] = [];
  const successMessages: string[] = [];
  let reportFails = options.reportError ?? false, recipientAccepted = false;
  const run: Record<string, unknown> = { id: "synthetic-run", pushType: "weekly", dryRun: options.dryRun ?? false };
  const counts = { total: 1, success: 1, failed: 0, skipped: 0, pending: 0, sending: 0, retryWait: 0, unknown: 0, ...options.counts };
  const dependencies = {
    queues: { weeklyPush: "synthetic-weekly-queue" },
    weeklyPushRepo: {
      getRunById: async () => options.missingRun ? undefined : run,
      updateRun: async (_id: string, patch: Record<string, unknown>) => {
        events.push(`run:${patch.status}`);
        if (options.failurePatchError && patch.status === "failed") throw new Error("synthetic-failure-state-write-error");
        Object.assign(run, patch);
        return options.missingFinalRun && patch.completedAt ? undefined : run;
      },
      listRecipientsByRun: async () => [{ id: "synthetic-recipient" }],
      updateRecipient: async () => { events.push("recipient:skipped"); },
      getRecipientById: async () => ({ status: options.existingRecipientStatus ?? "accepted" }),
      countRecipientStatuses: async () => counts,
    },
    deliverSavedRecipient: async () => {
      if (recipientAccepted) { events.push("recipient:already-accepted"); return { state: "unclaimed", retry: false }; }
      events.push("recipient:attempt"); recipientAccepted = true;
      return { state: options.deliverState ?? "accepted", retry: options.retry ?? false };
    },
    generateAndStoreReport: async () => { events.push("report"); if (reportFails) throw new Error("synthetic-private-report-error"); return "synthetic-report"; },
    pushRunSummary: async () => {
      assert.equal(run.status, "sending", "final success is not visible before summary acceptance");
      assert.equal(run.completedAt, null);
      events.push("summary:accepted"); if (options.summaryError) throw new Error("synthetic-private-summary-error");
      return { itPushed: true, xiePushed: false, status: options.summaryStatus ?? "accepted", configuredCount: options.summaryConfigured ?? 1 };
    },
    pingStart: async () => { events.push("monitor:start"); },
    pingSuccess: async (message?: string) => { events.push("monitor:success"); successMessages.push(message ?? ""); },
    pingFail: async (error: unknown) => { events.push("monitor:fail"); failures.push(error); },
    console: { error: () => {} },
  };
  return { events, failures, successMessages, run, allowReport: () => { reportFails = false; }, weekly: loadHandler("handleWeeklyPushJob", dependencies), report: loadHandler("handleReportJob", dependencies), recipient: loadHandler("handleRecipientJob", dependencies) };
}

const jobs = [{ name: "synthetic-weekly-queue", data: { runId: "synthetic-run" } }];
function assertFailurePing(f: ReturnType<typeof fixture>) {
  assert.equal(f.events.filter((event) => event === "monitor:start").length, 1);
  assert.equal(f.events.filter((event) => event === "monitor:fail").length, 1);
  assert.equal(f.events.filter((event) => event === "monitor:success").length, 0);
  assert.equal(typeof f.failures[0], "string", "monitor receives a constant safe string, never original Error/stack");
  assert.match(String(f.failures[0]), /^weekly_push_[a-z_]+$/);
  assert.doesNotMatch(String(f.failures[0]), /synthetic|private|recipient|\n/);
}

test("actual weekly handler starts once and succeeds only after final state, report and accepted summary", async () => {
  const f = fixture();
  await f.weekly(jobs);
  assert.deepEqual(f.events, ["monitor:start", "run:sending", "recipient:attempt", "run:sending", "report", "summary:accepted", "run:success", "monitor:success"]);
  assert.equal(f.run.status, "success");
  assert.doesNotMatch(f.successMessages[0], /delivered|received/i);
});

for (const [name, counts, status] of [
  ["unknown", { total: 1, success: 0, unknown: 1 }, "unknown"],
  ["failed", { total: 1, success: 0, failed: 1 }, "failed"],
  ["partial", { total: 2, success: 1, failed: 1 }, "partial_success"],
] as const) {
  test(`actual weekly ${name} outcome reports fail with no success`, async () => {
    const f = fixture({ counts });
    await f.weekly(jobs);
    assert.equal(f.run.status, status);
    assertFailurePing(f);
  });
}

for (const [name, options] of [
  ["pending retry", { retry: true }],
  ["missing run", { missingRun: true }],
  ["report failure", { reportError: true }],
  ["summary exception", { summaryError: true }],
  ["missing final persisted row", { missingFinalRun: true }],
] as const) {
  test(`actual weekly ${name} rejects and reports one safe failure`, async () => {
    const f = fixture(options);
    await assert.rejects(f.weekly(jobs));
    assertFailurePing(f);
    if (options.reportError || options.summaryError || options.missingFinalRun) {
      assert.equal(f.run.status, "failed");
      assert.equal(f.run.completedAt, null);
    }
  });
}

test("actual report handler propagates storage failure to pg-boss retry", async () => {
  const f = fixture({ reportError: true });
  await assert.rejects(f.report(jobs), /synthetic-private-report-error/);
});

test("actual dry run still monitors one final completion without recipient HTTP", async () => {
  const f = fixture({ dryRun: true, counts: { success: 0, skipped: 1 } });
  await f.weekly(jobs);
  assert.equal(f.events.includes("recipient:attempt"), false);
  assert.equal(f.events.filter((event) => event === "monitor:start").length, 1);
  assert.equal(f.events.filter((event) => event === "monitor:success").length, 1);
});

for (const status of ["unknown", "failed", "not_configured"] as const) {
  test(`configured summary ${status} cannot complete a weekly job successfully`, async () => {
    const f = fixture({ summaryStatus: status });
    await assert.rejects(f.weekly(jobs));
    assert.equal(f.run.status, status === "unknown" ? "unknown" : "failed");
    assert.equal(f.run.completedAt, null);
    assertFailurePing(f);
  });
}

test("absent optional summary groups remain explicitly not configured", async () => {
  const f = fixture({ summaryStatus: "not_configured", summaryConfigured: 0 });
  await f.weekly(jobs);
  assert.equal(f.run.status, "success");
  assert.equal(f.events.at(-1), "monitor:success");
});

test("report retry runs the actual handler without repeating accepted recipient HTTP", async () => {
  const f = fixture({ reportError: true });
  await assert.rejects(f.weekly(jobs));
  assert.equal(f.run.status, "failed"); assert.equal(f.run.completedAt, null);
  f.allowReport();
  await f.weekly(jobs);
  assert.equal(f.events.filter(event => event === "recipient:attempt").length, 1);
  assert.equal(f.events.filter(event => event === "recipient:already-accepted").length, 1);
  assert.equal(f.events.filter(event => event === "report").length, 2);
  assert.equal(f.run.status, "success");
});

test("unclaimed active recipient prevents final success and requests retry", async () => {
  const f = fixture({ deliverState: "unclaimed", existingRecipientStatus: "processing" });
  await assert.rejects(f.weekly(jobs), /unsettled/);
  assertFailurePing(f);
  assert.equal(f.events.includes("report"), false);
});

test("recipient-only manual retry finalizes without scheduled reconciliation and retains accepted state across report retry", async () => {
  const f = fixture({ reportError: true });
  f.run.status = "queued"; f.run.completedAt = new Date(0);
  const recipientJobs = [{ data: { runId: "synthetic-run", recipientId: "synthetic-recipient" } }];
  await assert.rejects(f.recipient(recipientJobs));
  assert.equal(f.run.status, "failed"); assert.equal(f.run.completedAt, null);
  f.allowReport();
  await f.recipient(recipientJobs);
  assert.equal(f.run.status, "success");
  assert.equal(f.events.filter(event => event === "recipient:attempt").length, 1);
  assert.equal(f.events.filter(event => event === "report").length, 2);
});

test("generic notification delivery cannot ping the weekly monitor", async () => {
  const f = fixture();
  f.run.pushType = "notification";
  await f.weekly([{ name: "synthetic-generic-queue", data: { runId: "synthetic-run" } }]);
  assert.equal(f.events.some(event => event.startsWith("monitor:")), false);
  assert.equal(f.events.includes("report"), false);
  assert.equal(f.run.status, "success");
});

test("weekly recovery still reports one safe failure if persisting the failed run also throws", async () => {
  const f = fixture({ reportError: true, failurePatchError: true });
  await assert.rejects(f.recipient([{ data: { runId: "synthetic-run", recipientId: "synthetic-recipient" } }]));
  assertFailurePing(f);
});
