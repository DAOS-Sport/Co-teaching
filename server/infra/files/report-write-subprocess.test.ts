import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { boundedReportSubprocess, ReportStorageWriteError } from "./report-write-subprocess";

const uri = "objstore://weekly-push-reports/synthetic-run.csv";
function childFixture(script: string) {
  let pid: number | undefined;
  let closed = false;
  let spawnCount = 0;
  const output: string[] = [];
  const spawnImpl: typeof spawn = ((command: string, _args: readonly string[], options: any) => {
    assert.equal(command, process.execPath);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    spawnCount++;
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", script], { ...options, env: {} });
    pid = child.pid;
    child.on("close", () => { closed = true; });
    child.stdout?.on("data", (chunk) => output.push(chunk.toString()));
    return child;
  }) as typeof spawn;
  return { deps: { spawn: spawnImpl }, pid: () => pid, closed: () => closed, count: () => spawnCount, output };
}
function dead(pid: number | undefined) {
  assert.ok(pid);
  assert.throws(() => process.kill(pid!, 0), (error: any) => error.code === "ESRCH");
}
const success = `let input = []; process.stdin.on('data', c => input.push(c)); process.stdin.on('end', () => {
  const buffer = Buffer.concat(input); const cut = buffer.indexOf(10); const header = JSON.parse(buffer.subarray(0, cut));
  if (header.version !== 1 || header.runId !== 'synthetic-run' || header.ext !== 'csv' || header.contentLength !== buffer.length-cut-1) process.exit(2);
  process.stdout.write('${uri}\\n', () => process.exit(0));
});`;

test("real child success returns stable URI only after close and PID absence", async () => {
  const h = childFixture(success);
  const result = await boundedReportSubprocess("synthetic-run", "header\n" + Array.from({ length: 400 }, (_, i) => `synthetic-${i}`).join("\n"), "csv", {
    signal: new AbortController().signal, timeoutMs: 4000,
  }, h.deps);
  assert.equal(result, uri);
  assert.equal(h.closed(), true);
  dead(h.pid());
});

test("real stalled child timeout is killed and all stdio closes before rejection", async () => {
  const h = childFixture("process.stdin.resume(); setInterval(() => {}, 1000); process.on('SIGTERM', () => {});");
  await assert.rejects(boundedReportSubprocess("synthetic-run", "report", "csv", {
    signal: new AbortController().signal, timeoutMs: 200,
  }, h.deps), /report_storage_timeout/);
  assert.equal(h.closed(), true);
  dead(h.pid());
});

test("success stdout without process exit cannot complete the write", async () => {
  const h = childFixture(`process.stdin.resume(); process.stdout.write('${uri}\\n'); setInterval(() => {}, 1000);`);
  await assert.rejects(boundedReportSubprocess("synthetic-run", "report", "csv", {
    signal: new AbortController().signal, timeoutMs: 200,
  }, h.deps), /report_storage_timeout/);
  assert.equal(h.closed(), true);
  dead(h.pid());
});

test("real child abort cannot leave a delayed auth/HTTP continuation alive", async () => {
  const h = childFixture("process.stdin.resume(); setTimeout(() => process.stdout.write('late_fake_auth_http_started'), 1000); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const writing = boundedReportSubprocess("synthetic-run", "report", "csv", { signal: controller.signal, timeoutMs: 4000 }, h.deps);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(writing, /report_storage_aborted/);
  assert.equal(h.closed(), true);
  dead(h.pid());
  assert.equal(h.output.join("").includes("late_fake_auth_http_started"), false);
});

test("pre-abort, invalid budget/run and >2MiB stdin reject without spawning", async () => {
  const h = childFixture(success);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(boundedReportSubprocess("synthetic-run", "report", "csv", { signal: controller.signal, timeoutMs: 100 }, h.deps), /report_storage_aborted/);
  await assert.rejects(boundedReportSubprocess("../run", "report", "csv", { signal: new AbortController().signal, timeoutMs: 100 }, h.deps), /report_storage_request_invalid/);
  await assert.rejects(boundedReportSubprocess("synthetic-run", Buffer.alloc(2 * 1024 * 1024), "csv", { signal: new AbortController().signal, timeoutMs: 100 }, h.deps), /report_storage_payload_too_large/);
  await assert.rejects(boundedReportSubprocess("synthetic-run", "report", "csv", { signal: new AbortController().signal, timeoutMs: 0 }, h.deps), /report_storage_budget_exhausted/);
  assert.equal(h.count(), 0);
});

test("child nonzero exit/raw diagnostics and oversized output remain static", async () => {
  for (const script of [
    "process.stdin.resume(); process.stderr.write('sensitive credentials and upstream URI'); process.stdout.write('sensitive-output'); process.exit(1);",
    "process.stdin.resume(); process.stdout.write('x'.repeat(2000)); setInterval(() => {}, 1000);",
    `process.stdin.resume(); process.stdout.write('objstore://wrong/key\\n'); process.exit(0);`,
  ]) {
    const h = childFixture(script);
    await assert.rejects(boundedReportSubprocess("synthetic-run", "report", "csv", {
      signal: new AbortController().signal, timeoutMs: 4000,
    }, h.deps), (error: unknown) => {
      assert.ok(error instanceof ReportStorageWriteError);
      assert.doesNotMatch(error.message, /sensitive|wrong|credentials/);
      return true;
    });
    assert.equal(h.closed(), true);
    dead(h.pid());
  }
});

test("spawn failure returns a static error", async () => {
  await assert.rejects(boundedReportSubprocess("synthetic-run", "report", "csv", {
    signal: new AbortController().signal, timeoutMs: 100,
  }, { spawn: (() => { throw Error("private spawn diagnostics"); }) as typeof spawn }),
  (error: unknown) => error instanceof ReportStorageWriteError && error.message === "report_storage_child_failed");
});

test("real source child malformed request and missing durable config fail before network", async () => {
  for (const payload of [Buffer.from("not-json\n"), Buffer.from(JSON.stringify({ version: 1, runId: "synthetic-run", ext: "csv", contentLength: 6, timeoutMs: 1000 }) + "\nreport")]) {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./report-write-child.ts", import.meta.url))], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {},
    });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const done = new Promise<number | null>((resolve) => child.once("close", resolve));
    child.stdin.end(payload);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    const code = await done;
    clearTimeout(timeout);
    assert.equal(code, 1);
    assert.match(Buffer.concat(output).toString().trim(), /^report_storage_(request_invalid|required)$/);
    assert.equal(Buffer.concat(errors).toString(), "");
    dead(child.pid);
  }
});
