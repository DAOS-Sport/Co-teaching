import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as scheduleUi from "./schedule-ui";
import { assignmentChanges, batchContext, bindPreview, canCommitPreview, clearSubmittedDraft, failedSaveState, notificationReceiptLabel, ordinarySaveReceipt, previewCommitToken, previewRows, readScheduleLocation, remainingDraft, scheduleCellKey, scheduleLocation, validDateOnly, type BatchPreview } from "./schedule-ui";

test("weekly run detail counts platform acceptance as complete in the actual component summary", () => {
  const ast = parse("components/weekly-push/RunDetailDialog.tsx");
  let expression: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "counts") expression = node.initializer?.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression);
  const context = { recipients: [...Array.from({ length: 25 }, () => ({ status: "accepted" })), { status: "failed" }],
    summarizeNotificationRecipients: scheduleUi.summarizeNotificationRecipients, actual: undefined };
  vm.runInNewContext(`actual = ${expression}`, context);
  assert.deepEqual(context.actual, { total: 26, success: 25, failed: 1, skipped: 0, pending: 0, unknown: 0 });
});

test("notification summary retains legacy success and separates retries from unknown states", () => {
  const statuses = ["success", "accepted", "failed", "skipped", "pending", "queued", "processing", "sending", "retry_wait", "unknown", "future_status"];
  assert.deepEqual(scheduleUi.summarizeNotificationRecipients(statuses.map(status => ({ status }))),
    { total: 11, success: 2, failed: 1, skipped: 1, pending: 5, unknown: 2 });
});

test("empty notification summaries contain no implied acceptance or work", () => {
  assert.deepEqual(scheduleUi.summarizeNotificationRecipients([]),
    { total: 0, success: 0, failed: 0, skipped: 0, pending: 0, unknown: 0 });
});

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parse(relative: string) {
  return ts.createSourceFile(relative, readFileSync(path.join(clientRoot, relative), "utf8"), ts.ScriptTarget.Latest, true);
}
function bodyProperties(url: string) {
  const ast = parse("pages/venue-schedule-edit.tsx");
  const properties: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === url) {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const body = options.properties.find((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === "body");
        if (body && ts.isPropertyAssignment(body) && ts.isCallExpression(body.initializer)) {
          const payload = body.initializer.arguments[0];
          if (payload && ts.isObjectLiteralExpression(payload)) for (const item of payload.properties) if ((ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && ts.isIdentifier(item.name)) properties.push(item.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return properties;
}

for (const url of ["/api/admin/schedules/import/commit", "/api/schedules/copy-week"]) test(`batch commit body carries the current confirmation token: ${url}`, () => {
  assert.ok(bodyProperties(url).includes("confirmationToken"));
});

test("client import URLs match the independently registered API routes", () => {
  const routesFile = path.resolve(clientRoot, "../../server/modules/schedule.routes.ts");
  const routes = ts.createSourceFile(routesFile, readFileSync(routesFile, "utf8"), ts.ScriptTarget.Latest, true);
  const client = parse("pages/venue-schedule-edit.tsx");
  const urls = (ast: ts.SourceFile, kind: "server" | "client") => {
    const result: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /\/schedules\/import\/(preview|commit)$/.test(node.arguments[0].text)) {
        if (kind === "client" ? ts.isIdentifier(node.expression) && node.expression.text === "fetch" : ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "post") result.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast); return result.sort();
  };
  assert.equal(urls(routes, "server").length, 2);
  assert.deepEqual(urls(client, "client"), urls(routes, "server"));
});

for (const file of ["pages/venue-schedule-edit.tsx", "pages/coach-assignment.tsx"]) test(`${file} restores filter state on browser history traversal`, () => {
  const ast = parse(file);
  let found = false;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addEventListener" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "popstate") found = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(found, true);
});

test("schedule HTTP errors preserve status and business code for version-conflict UI", async () => {
  const file = path.join(clientRoot, "lib/queryClient.ts");
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  const context = {
    module, exports: module.exports,
    require(name: string) {
      if (name === "@tanstack/react-query") return { QueryClient: class { invalidateQueries() {} } };
      if (name === "@/components/confirm-popup") return { askConfirm: async () => true };
      throw new Error("Unexpected test dependency");
    },
    fetch: async () => new Response(JSON.stringify({ code: "VERSION_CONFLICT", message: "Synthetic conflict" }), { status: 409 }),
  };
  vm.runInNewContext(compiled, context, { filename: file, timeout: 5_000 });
  await assert.rejects(module.exports.apiRequestWithConfirm("PUT", "/synthetic", {}), { code: "VERSION_CONFLICT", status: 409 });
});

test("public filter URLs validate dates, normalize Mondays and discard secret query keys", () => {
  const fallback = new Date(2026, 9, 14, 12);
  const state = readScheduleLocation("?venueId=synthetic&week=2026-10-18&password=synthetic&confirmationToken=synthetic", fallback);
  assert.equal(scheduleLocation("/synthetic", state.venueId, state.week), "/synthetic?venueId=synthetic&week=2026-10-12");
  const invalid = readScheduleLocation("?venueId=%3Cscript%3E&week=2026-02-30", fallback);
  assert.equal(scheduleLocation("/synthetic", invalid.venueId, invalid.week), "/synthetic?week=2026-10-12");
  assert.equal(validDateOnly("2024-02-29"), true);
  assert.equal(validDateOnly("2026-02-29"), false);
  for (const search of ["?venueId=first&week=2026-10-05", "?venueId=second&week=2026-10-12", "?venueId=first&week=2026-10-05"]) {
    const restored = readScheduleLocation(search, fallback);
    assert.equal(scheduleLocation("/synthetic", restored.venueId, restored.week), `/synthetic${search}`);
  }
});

test("only an unchanged input context can commit a signed preview", () => {
  const value: BatchPreview = { rows: [], summary: { total: 1, create: 1, update: 0, skip: 0, error: 0, warning: 0 }, canCommit: true, confirmationToken: "synthetic-token" };
  const first = batchContext({ venueId: "synthetic", text: "first", mode: "insert_only" });
  assert.equal(first, batchContext({ mode: "insert_only", text: "first", venueId: "synthetic" }));
  const bound = bindPreview(value, first);
  assert.equal(previewCommitToken(bound, first), "synthetic-token");
  for (const changed of [batchContext({ venueId: "other", text: "first", mode: "insert_only" }), batchContext({ venueId: "synthetic", text: "changed", mode: "insert_only" })]) {
    assert.equal(canCommitPreview(bound, changed), false);
    assert.throws(() => previewCommitToken(bound, changed), { code: "PREVIEW_REQUIRED" });
  }
  assert.equal(canCommitPreview(bindPreview({ ...value, confirmationToken: undefined }, first), first), false);
  const fresh409 = bindPreview({ ...value, confirmationToken: "fresh-token" }, first);
  assert.equal(previewCommitToken(fresh409, first), "fresh-token");
  assert.equal(value.confirmationToken, "synthetic-token");
});

test("unified preview preserves server statuses, changes, clear fields and separate skipped rows", () => {
  const rows = previewRows({ rows: [{ date: "2026-10-12", className: "Synthetic", status: "update", changes: [{ field: "notes", before: "old", after: null }], clearedFields: ["notes"], issues: [{ severity: "warning", code: "synthetic", message: "Synthetic warning" }] }, { date: "2026-10-13", className: "Synthetic error", issues: [{ severity: "error", code: "synthetic", message: "Synthetic error" }] }], skippedRows: [{ date: "2026-10-14", className: "Synthetic skip", status: "skip", reason: "occupied_cell" }], summary: { total: 3, create: 0, update: 1, skip: 1, error: 1, warning: 1 }, canCommit: false });
  assert.deepEqual(rows.map((row) => row.status), ["update", "error", "skip"]);
  assert.equal(rows[0].changes?.[0].before, "old");
  assert.deepEqual(rows[0].clearedFields, ["notes"]);
  assert.equal(rows[2].reason, "occupied_cell");
});

test("save acknowledgements never erase newer drafts or a different venue's cell", () => {
  const key = scheduleCellKey("first", "2026-10-12", "slot");
  assert.notEqual(key, scheduleCellKey("second", "2026-10-12", "slot"));
  assert.deepEqual(clearSubmittedDraft({ [key]: "new input" }, key, "old input"), { [key]: "new input" });
  assert.deepEqual(clearSubmittedDraft({ [key]: "submitted" }, key, "submitted"), {});
  assert.deepEqual(remainingDraft({ coachName: "new", coach2IsTeaching: false }, { coachName: "old", coach2IsTeaching: false }), { coachName: "new" });
  assert.equal(failedSaveState({ code: "VERSION_CONFLICT" }), "conflict");
  assert.equal(failedSaveState(new Error("Synthetic network error")), "error");
  assert.deepEqual(assignmentChanges({ coachName: "old", coachName2: null, coach1IsTeaching: true }, { coachName: "new", coachName2: null, coach1IsTeaching: true }), [{ field: "coachName", before: "old", after: "new" }]);
});

test("storage and notification receipts distinguish pending, accepted, unknown and absent delivery", () => {
  assert.match(ordinarySaveReceipt, /已儲存.*未安排通知/);
  assert.match(notificationReceiptLabel("pending"), /佇列.*尚未受理/);
  assert.match(notificationReceiptLabel("accepted"), /LINE 已受理.*不代表已送達/);
  assert.match(notificationReceiptLabel("unknown"), /未確認.*尚未證實/);
  assert.match(notificationReceiptLabel("not_configured"), /未設定.*未安排/);
  assert.match(notificationReceiptLabel("unchanged"), /未變.*沒有新增/);
});

test("the shared batch preview renders changes, clears, warning and skip reasons together", () => {
  const file = path.join(clientRoot, "components/schedule/batch-plan-preview.tsx");
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { module, exports: module.exports, require(name: string) {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "@/lib/schedule-ui") return scheduleUi;
    throw new Error("Unexpected component test dependency");
  } }, { filename: file, timeout: 5_000 });
  const preview: BatchPreview = { rows: [{ date: "2026-10-12", className: "Synthetic", status: "update", changes: [{ field: "notes", before: "Synthetic old note", after: null }], clearedFields: ["notes"], issues: [{ severity: "warning", code: "synthetic", message: "Synthetic warning" }] }], skippedRows: [{ date: "2026-10-13", className: "Synthetic skipped", status: "skip", reason: "occupied_cell" }], summary: { total: 2, create: 0, update: 1, skip: 1, error: 0, warning: 1 }, canCommit: true };
  const html = renderToStaticMarkup(createElement(module.exports.BatchPlanPreview, { preview }));
  for (const expected of ["修改前 → 修改後", "Synthetic old note", "將清空：", "Synthetic warning", "目標格已有課程", 'data-status="skip"']) assert.ok(html.includes(expected), expected);
});

function coachCountMutationFixture() {
  const file = path.join(clientRoot, "pages/venue-schedule-edit.tsx");
  const source = readFileSync(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let options = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "updateCoachCountMutation" && node.initializer && ts.isCallExpression(node.initializer)) options = source.slice(node.initializer.arguments[0].getStart(ast), node.initializer.arguments[0].end);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(options);
  const compiled = ts.transpileModule(`module.exports = function(deps) { const { setCoachCountDrafts, setCoachCountSaveState, setCoachCountErrors, coachCountRevisions, queryClient, toast, apiRequestWithConfirm, cachedScheduleVersion, clearSubmittedDraft, failedSaveState, ordinarySaveReceipt } = deps; return (${options}); };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { module, exports: module.exports }, { filename: "synthetic-count-mutation.ts", timeout: 5_000 });
  let drafts: Record<string, number> = {}, states: Record<string, string> = {}, errors: Record<string, string> = {};
  const toasts: any[] = [], requests: any[] = [];
  const mutation = module.exports({
    setCoachCountDrafts: (update: any) => { drafts = typeof update === "function" ? update(drafts) : update; },
    setCoachCountSaveState: (update: any) => { states = typeof update === "function" ? update(states) : update; },
    setCoachCountErrors: (update: any) => { errors = typeof update === "function" ? update(errors) : update; },
    coachCountRevisions: { current: {} }, queryClient: { invalidateQueries() {} }, toast: (entry: unknown) => toasts.push(entry),
    apiRequestWithConfirm: async (_method: string, _url: string, payload: unknown) => { requests.push(payload); return { json: async () => ({ coachCount: 1 }) }; },
    cachedScheduleVersion: () => 3, clearSubmittedDraft, failedSaveState, ordinarySaveReceipt,
  });
  return { mutation, toasts, requests, drafts: () => drafts, states: () => states, errors: () => errors };
}

test("coach-count failure and background data retain the selected draft, with explicit save receipt", async () => {
  const fixture = coachCountMutationFixture(), variables = { scheduleId: "synthetic", coachCount: 2 };
  const context = fixture.mutation.onMutate(variables);
  assert.equal(fixture.drafts().synthetic, 2);
  fixture.mutation.onError(Object.assign(new Error("Synthetic version conflict"), { code: "VERSION_CONFLICT" }), variables, context);
  assert.equal(fixture.drafts().synthetic, 2);
  assert.equal(fixture.states().synthetic, "conflict");
  const refreshedBackendCount = 1;
  assert.equal(fixture.drafts().synthetic ?? refreshedBackendCount, 2);
  fixture.mutation.onSuccess({ coachCount: 2 }, variables, context);
  assert.equal(fixture.drafts().synthetic, undefined);
  assert.equal(fixture.states().synthetic, "saved");
  assert.match(fixture.toasts.at(-1).description, /已儲存.*未安排通知/);
});

test("older coach-count responses cannot clear or relabel a newer draft", () => {
  const fixture = coachCountMutationFixture();
  const first = { scheduleId: "synthetic", coachCount: 1 }, second = { scheduleId: "synthetic", coachCount: 2 };
  const old = fixture.mutation.onMutate(first), current = fixture.mutation.onMutate(second);
  fixture.mutation.onSuccess({}, first, old);
  assert.equal(fixture.drafts().synthetic, 2);
  assert.equal(fixture.states().synthetic, "saving");
  fixture.mutation.onError(new Error("Synthetic old failure"), first, old);
  assert.equal(fixture.states().synthetic, "saving");
  fixture.mutation.onError(new Error("Synthetic network failure"), second, current);
  assert.equal(fixture.drafts().synthetic, 2);
  assert.equal(fixture.states().synthetic, "error");
});

test("coach-count request sends only its existing count and version contract", async () => {
  const fixture = coachCountMutationFixture();
  await fixture.mutation.mutationFn({ scheduleId: "synthetic", coachCount: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests)), [{ coachCount: 1, expectedVersion: 3 }]);
});

function assignmentMutationFixture() {
  const file = path.join(clientRoot, "pages/coach-assignment.tsx");
  const source = readFileSync(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let options = "", receipt = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "assignCoachMutation" && node.initializer && ts.isCallExpression(node.initializer)) options = source.slice(node.initializer.arguments[0].getStart(ast), node.initializer.arguments[0].end);
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "data-testid" && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "assignment-receipt")) receipt = source.slice(node.getStart(ast), node.end);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(options); assert.ok(receipt);
  const compiled = ts.transpileModule(`
    module.exports = (deps) => {
      const { schedules, draftsRef, rowRevisions, assignmentFieldRevisions, assignmentPending, setAssignmentDrafts, setDraftBases, setAssignmentSaveState, setAssignmentErrors, setSavedChanges, remainingDraft, assignmentChanges, failedSaveState, ordinarySaveReceipt, queryClient, toast, cachedScheduleVersion, apiRequestWithConfirm } = deps;
      return (${options});
    };
    module.exports.Receipt = (props) => {
      const { rowState, rowDraft, rowChanges, assignmentErrors, schedule, ordinarySaveReceipt, fieldLabels, displayField, Button, refetchSchedules, refetchConflicts, assignCoachMutation, draftsRef, setAssignmentDrafts, setAssignmentSaveState } = props;
      return (${receipt});
    };`, { fileName: "assignment-callbacks.tsx", compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { module, exports: module.exports, localStorage: { setItem() {} }, require(name: string) { if (name === "react/jsx-runtime") return jsxRuntime; throw new Error("unexpected assignment import"); } }, { filename: file, timeout: 5_000 });
  const schedules = [{ id: "synthetic", coachName: null, coachName2: null, coach1IsTeaching: true, coach2IsTeaching: false, version: 1 }];
  const draftsRef = { current: {} as Record<string, Record<string, unknown>> };
  let states: Record<string, string> = {}, errors: Record<string, string> = {}, bases = {}, changes = {};
  const toasts: any[] = [], requests: any[] = [];
  const setAssignmentDrafts = (update: any) => { draftsRef.current = typeof update === "function" ? update(draftsRef.current) : update; };
  const setAssignmentSaveState = (update: any) => { states = typeof update === "function" ? update(states) : update; };
  const mutation = module.exports({ schedules, draftsRef, rowRevisions: { current: {} }, assignmentFieldRevisions: { current: {} }, assignmentPending: { current: {} },
    setAssignmentDrafts, setAssignmentSaveState,
    setDraftBases: (update: any) => { bases = typeof update === "function" ? update(bases) : update; },
    setAssignmentErrors: (update: any) => { errors = typeof update === "function" ? update(errors) : update; },
    setSavedChanges: (update: any) => { changes = typeof update === "function" ? update(changes) : update; },
    remainingDraft, assignmentChanges, failedSaveState, ordinarySaveReceipt, queryClient: { invalidateQueries() {} }, toast: (entry: unknown) => toasts.push(entry),
    cachedScheduleVersion: () => 1, apiRequestWithConfirm: async (_method: string, _url: string, payload: unknown, preconfirmed: string[] = []) => { requests.push({ payload, preconfirmed }); return { json: async () => ({}) }; },
  });
  return { mutation, toasts, requests, drafts: () => draftsRef.current, states: () => states, errors: () => errors,
    saved: (patch: Record<string, unknown> = {}) => ({ ...schedules[0], ...patch }),
    receipt: () => renderToStaticMarkup(createElement(module.exports.Receipt, { rowState: states.synthetic, rowDraft: draftsRef.current.synthetic, rowChanges: [], assignmentErrors: errors, schedule: schedules[0], ordinarySaveReceipt, fieldLabels: scheduleUi.fieldLabels, displayField: scheduleUi.displayField, Button: ({ children }: any) => createElement("button", {}, children), refetchSchedules() {}, refetchConflicts() {}, assignCoachMutation: mutation, draftsRef, setAssignmentDrafts, setAssignmentSaveState })),
  };
}

test("candidate availability labels distinguish an unfilled week from a missing slot and agree with core warnings", () => {
  const relative = "pages/coach-assignment.tsx", source = readFileSync(path.join(clientRoot, relative), "utf8"), ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const spans: string[] = [];
  let reasonFunction = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "candidateAvailabilityReason") reasonFunction = source.slice(node.getStart(ast), node.end).replace(/^export\s+/, "");
    if (ts.isJsxElement(node) && ts.isIdentifier(node.openingElement.tagName) && node.openingElement.tagName.text === "span" && node.openingElement.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === "className" && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "block text-[10px] font-normal")) spans.push(source.slice(node.getStart(ast), node.end));
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(spans.length, 2);
  const coreFile = path.resolve(clientRoot, "../../server/core/scheduling/policies.ts");
  const core = { exports: {} as any };
  vm.runInNewContext(ts.transpileModule(readFileSync(coreFile, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: core, exports: core.exports, require: () => ({ ScheduleMutationError: class extends Error {} }) });
  const row = { id: "synthetic", date: "2026-10-20", timeSlotId: "slot", venueId: "venue" };
  const context = { sameDaySchedules: [], timeSlots: [{ id: "slot", order: 2 }], weekAvailability: [] as any[] };
  assert.equal(core.exports.assignmentWarnings(row, ["synthetic"], context).length, 0);
  context.weekAvailability = [{ coachName: "synthetic", dayOfWeek: 1, timeSlotOrder: 1 }];
  assert.equal(core.exports.assignmentWarnings(row, ["synthetic"], context).length, 1);
  for (const span of spans) {
    const module = { exports: {} as any };
    const compiled = ts.transpileModule(`${reasonFunction}\nmodule.exports=(props)=>{const {isHard,isSoft,softConflicts,coach,available,availabilityFilled,timeAvailable,availabilityState}=props;return (${span});};`, { fileName: "candidate-reason.tsx", compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, require: () => jsxRuntime });
    const props = { isHard: false, isSoft: false, softConflicts: new Map(), coach: "synthetic", available: new Set<string>(), availabilityFilled: new Set<string>(), timeAvailable: new Set<string>(), availabilityState: "ready" };
    const render = () => renderToStaticMarkup(createElement(module.exports, props));
    assert.match(render(), /本週尚未填可上課時段/);
    assert.doesNotMatch(render(), /需確認/);
    props.availabilityFilled.add("synthetic");
    assert.match(render(), /未登記此時段.*需確認/);
    props.timeAvailable.add("synthetic");
    assert.match(render(), /已登記此時段/);
    assert.doesNotMatch(render(), /需確認/);
    props.availabilityState = "loading";
    assert.match(render(), /載入中/);
    assert.doesNotMatch(render(), /需確認/);
    props.availabilityState = "error";
    assert.match(render(), /讀取失敗/);
    assert.doesNotMatch(render(), /需確認/);
  }
});

test("candidate reasons receive raw week and slot availability even when venue filtering excludes a coach", () => {
  const relative = "pages/coach-assignment.tsx", source = readFileSync(path.join(clientRoot, relative), "utf8"), ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (["availabilityMap", "availabilityFilled"].includes(node.name.text) && ts.isCallExpression(node.initializer)) expressions[node.name.text] = "(" + source.slice(node.initializer.arguments[0].getStart(ast), node.initializer.arguments[0].end) + ")()";
      if (node.name.text === "timeAvailable") expressions.timeAvailable = source.slice(node.initializer.getStart(ast), node.initializer.end);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(expressions.availabilityMap); assert.ok(expressions.availabilityFilled); assert.ok(expressions.timeAvailable);
  const compiled = ts.transpileModule(`module.exports=(availability,dayOfWeek,timeSlot)=>{const availabilityMap=(${expressions.availabilityMap}); const availabilityFilled=(${expressions.availabilityFilled}); const timeAvailable=(${expressions.timeAvailable}); return {availabilityFilled,timeAvailable};};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { module });
  const data = module.exports([{ coachName: "synthetic", dayOfWeek: 2, timeSlotOrder: 2 }], 2, { order: 2 });
  assert.equal(data.availabilityFilled.has("synthetic"), true);
  assert.equal(data.timeAvailable.has("synthetic"), true);
});

test("coach saves and draft retries do not preconfirm a warning the server has not returned", async () => {
  const fixture = assignmentMutationFixture();
  await fixture.mutation.mutationFn({ scheduleId: "synthetic", coachName: "synthetic-coach" });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[0].preconfirmed)), []);
  await fixture.mutation.mutationFn({ scheduleId: "synthetic", coachName: "synthetic-coach", confirmWarnings: ["COACH_CONFLICT"] });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.requests[1].preconfirmed)), ["COACH_CONFLICT"]);
});

test("empty-warning confirmation explains changed context and only resends the supplied server token after consent", async () => {
  const file = path.join(clientRoot, "lib/queryClient.ts");
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  for (const message of ["synthetic context changed", ""]) {
    const module = { exports: {} as any }, confirmations: any[] = [], requests: any[] = [];
    vm.runInNewContext(compiled, { module, exports: module.exports, require(name: string) {
      if (name === "@tanstack/react-query") return { QueryClient: class { invalidateQueries() {} } };
      if (name === "@/components/confirm-popup") return { askConfirm: async (...args: unknown[]) => { confirmations.push(args); return true; } };
      throw new Error("unexpected confirmation import");
    }, fetch: async (_url: string, options: RequestInit) => {
      requests.push(JSON.parse(String(options.body)));
      return requests.length === 1 ? new Response(JSON.stringify({ code: "CONFIRM_REQUIRED", warnings: [], message, confirmationToken: "synthetic-context-token" }), { status: 409 }) : new Response("{}", { status: 200 });
    } }, { filename: file, timeout: 5_000 });
    await module.exports.apiRequestWithConfirm("PATCH", "/synthetic", { expectedVersion: 2 });
    assert.equal(confirmations.length, 1);
    assert.ok(confirmations[0][1].some((item: unknown) => typeof item === "string" && item.trim().length > 0));
    if (message) assert.ok(confirmations[0][1].includes(message));
    else assert.match(confirmations[0][1].join(" "), /資料狀態.*變更.*重新確認/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].confirmationToken, undefined);
    assert.deepEqual(requests[0].confirmWarnings, []);
    assert.equal(requests[1].confirmationToken, "synthetic-context-token");
    assert.deepEqual(requests[1].confirmWarnings, []);
  }
});

test("confirmation cancellation sends nothing further and a changed-context second response never loops", async () => {
  const file = path.join(clientRoot, "lib/queryClient.ts");
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  for (const consent of [false, true]) {
    let requests = 0, prompts = 0;
    const module = { exports: {} as any };
    vm.runInNewContext(compiled, { module, exports: module.exports, require(name: string) {
      if (name === "@tanstack/react-query") return { QueryClient: class { invalidateQueries() {} } };
      if (name === "@/components/confirm-popup") return { askConfirm: async () => { prompts++; return consent; } };
      throw new Error("unexpected confirmation import");
    }, fetch: async () => { requests++; return new Response(JSON.stringify({ code: "CONFIRM_REQUIRED", warnings: [{ code: "COACH_CONFLICT", message: "synthetic conflict" }], message: "synthetic changed again", confirmationToken: "synthetic-token" }), { status: 409 }); } }, { filename: file, timeout: 5_000 });
    if (consent) await assert.rejects(module.exports.apiRequestWithConfirm("PATCH", "/synthetic", {}), { code: "CONFIRM_REQUIRED", status: 409 });
    else await assert.rejects(module.exports.apiRequestWithConfirm("PATCH", "/synthetic", {}));
    assert.equal(prompts, 1);
    assert.equal(requests, consent ? 2 : 1);
  }
});

test("assignment partial success keeps earlier failed input unsaved and retryable until acknowledged", () => {
  const fixture = assignmentMutationFixture();
  const first = { scheduleId: "synthetic", coachName: "synthetic-coach" }, second = { scheduleId: "synthetic", coach2IsTeaching: true };
  const failed = fixture.mutation.onMutate(first);
  fixture.mutation.onError(new Error("synthetic first failure"), first, failed);
  assert.equal(fixture.drafts().synthetic.coachName, first.coachName);
  const latest = fixture.mutation.onMutate(second);
  fixture.mutation.onSuccess(fixture.saved({ coach2IsTeaching: true, version: 2 }), second, latest);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.drafts().synthetic)), { coachName: first.coachName });
  assert.equal(fixture.states().synthetic, "dirty");
  assert.match(fixture.receipt(), /尚未儲存/);
  assert.match(fixture.receipt(), /確認重試/);
  assert.ok(!fixture.receipt().includes(ordinarySaveReceipt));
  assert.ok(!fixture.toasts.some((entry) => entry.description === ordinarySaveReceipt));
  const retry = { scheduleId: "synthetic", ...fixture.drafts().synthetic }, retryContext = fixture.mutation.onMutate(retry);
  fixture.mutation.onSuccess(fixture.saved({ coachName: first.coachName, coach2IsTeaching: true, version: 3 }), retry, retryContext);
  assert.equal(fixture.drafts().synthetic, undefined);
  assert.equal(fixture.states().synthetic, "saved");
  assert.ok(fixture.receipt().includes(ordinarySaveReceipt));
  assert.ok(!fixture.receipt().includes("確認重試"));
});

test("assignment tracks parallel disjoint requests until both settle and preserves an older failed field", () => {
  for (const firstSucceeds of [false, true]) {
    const fixture = assignmentMutationFixture();
    const first = { scheduleId: "synthetic", coachName: "synthetic-coach" }, second = { scheduleId: "synthetic", coach2IsTeaching: true };
    const older = fixture.mutation.onMutate(first), latest = fixture.mutation.onMutate(second);
    fixture.mutation.onSuccess(fixture.saved({ coach2IsTeaching: true, version: 3 }), second, latest);
    assert.equal(fixture.states().synthetic, "saving");
    assert.equal(fixture.drafts().synthetic.coachName, first.coachName);
    if (firstSucceeds) fixture.mutation.onSuccess(fixture.saved({ coachName: first.coachName, version: 2 }), first, older);
    else fixture.mutation.onError(new Error("synthetic older failure"), first, older);
    assert.equal(fixture.states().synthetic, firstSucceeds ? "saved" : "error");
    assert.equal(fixture.drafts().synthetic?.coachName, firstSucceeds ? undefined : first.coachName);
    assert.equal(fixture.receipt().includes("確認重試"), !firstSucceeds);
  }
});

test("an older success cannot clear a newer identical field submission, and obsolete failure cannot undo newer success", () => {
  const first = { scheduleId: "synthetic", coachName: "synthetic-coach" }, second = { ...first };
  const fixture = assignmentMutationFixture();
  const older = fixture.mutation.onMutate(first), latest = fixture.mutation.onMutate(second);
  fixture.mutation.onSuccess(fixture.saved({ coachName: first.coachName, version: 2 }), first, older);
  assert.equal(fixture.drafts().synthetic.coachName, second.coachName);
  assert.equal(fixture.states().synthetic, "saving");
  fixture.mutation.onError(Object.assign(new Error("synthetic current conflict"), { code: "VERSION_CONFLICT" }), second, latest);
  assert.equal(fixture.drafts().synthetic.coachName, second.coachName);
  assert.equal(fixture.states().synthetic, "conflict");
  assert.match(fixture.receipt(), /確認重試/);
  const reordered = assignmentMutationFixture();
  const obsolete = reordered.mutation.onMutate(first), current = reordered.mutation.onMutate({ ...second, coachName: "synthetic-newer" });
  reordered.mutation.onSuccess(reordered.saved({ coachName: "synthetic-newer", version: 3 }), { ...second, coachName: "synthetic-newer" }, current);
  assert.equal(reordered.states().synthetic, "saving");
  const toastCount = reordered.toasts.length;
  reordered.mutation.onError(new Error("synthetic obsolete failure"), first, obsolete);
  assert.equal(reordered.states().synthetic, "saved");
  assert.equal(reordered.drafts().synthetic, undefined);
  assert.equal(reordered.toasts.slice(toastCount).some((entry) => entry.variant === "destructive"), false);
});
