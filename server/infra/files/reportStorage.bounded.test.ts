import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as operationScope from "../../shared/http/operationScope";
import { ReportStorageWriteError } from "./report-write-subprocess";

function fixture(options: { privateDir?: string; saveFails?: boolean; childFails?: boolean } = {}) {
  const writes: { path: string; contents: string | Buffer }[] = [];
  const childCalls: any[] = [];
  const objects: string[] = [];
  const saveOptions: any[] = [];
  const logs: unknown[][] = [];
  let saves = 0;
  const module = { exports: {} as any };
  const imports: Record<string, unknown> = {
    fs: { promises: { mkdir: async () => {}, writeFile: async (destination: string, contents: string | Buffer) => { writes.push({ path: destination, contents }); } } },
    path,
    "../../shared/http/operationScope": operationScope,
    "./report-write-subprocess": {
      ReportStorageWriteError,
      boundedReportSubprocess: async (runId: string, contents: string | Buffer, ext: string, selected: any) => {
        childCalls.push({ runId, contents, ext, selected });
        if (options.childFails) throw new ReportStorageWriteError("report_storage_write_failed");
        return `objstore://weekly-push-reports/${runId}.${ext}`;
      },
    },
    "../../replit_integrations/object_storage/objectStorage": { objectStorageClient: {
      bucket: (bucket: string) => ({ file: (object: string) => {
        objects.push(`${bucket}/${object}`);
        return { save: async (_buffer: Buffer, selected: any) => {
          saves++; saveOptions.push(selected); if (options.saveFails) throw Error("synthetic-provider-secret");
        } };
      } }),
    } },
  };
  const source = readFileSync(new URL("./reportStorage.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, {
    module, exports: module.exports, Buffer, Date,
    process: { env: { PRIVATE_OBJECT_DIR: options.privateDir } },
    console: { error: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); } },
    require(name: string) { assert.ok(name in imports, `unstubbed dependency ${name}`); return imports[name]; },
  }, { timeout: 5000 });
  return { storage: module.exports, writes, childCalls, objects, saveOptions, logs, saves: () => saves };
}
function scoped<T>(fn: () => T, controller = new AbortController(), budget = 5000): T {
  return operationScope.runInOperationScope({ signal: controller.signal, deadlineMs: Date.now() + budget }, fn);
}

test("scoped missing durable config fails before IO and never falls back to tmp", async () => {
  const f = fixture();
  await assert.rejects(scoped(() => f.storage.writeReport("synthetic-run", "report")), /report_storage_required/);
  assert.equal(f.writes.length, 0); assert.equal(f.objects.length, 0); assert.equal(f.childCalls.length, 0);
});

test("scoped malformed object-directory configuration is static and cannot spawn", async () => {
  for (const privateDir of ["/", "//bucket/private", "/bucket/../private", "bucket\\private"]) {
    const f = fixture({ privateDir });
    await assert.rejects(scoped(() => f.storage.writeReport("synthetic-run", "report")), /report_storage_config_invalid/);
    assert.equal(f.writes.length, 0); assert.equal(f.childCalls.length, 0); assert.equal(f.logs.length, 0);
  }
});

test("pre-aborted or less-than-reserve scope performs no object, child or filesystem IO", async () => {
  const f = fixture({ privateDir: "/fixture-bucket/private" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scoped(() => f.storage.writeReport("synthetic-run", "report"), controller), /operation_stopped/);
  await assert.rejects(scoped(() => f.storage.writeReport("synthetic-run", "report"), undefined, 1400), /operation_stopped/);
  assert.equal(f.objects.length, 0); assert.equal(f.childCalls.length, 0); assert.equal(f.writes.length, 0);
});

test("scoped write delegates SDK work to child with finite remaining timeout and 1500ms reserve", async () => {
  const f = fixture({ privateDir: "/fixture-bucket/private" });
  const result = await scoped(() => f.storage.writeReport("synthetic-run", "report", "xlsx"));
  assert.equal(result, "objstore://weekly-push-reports/synthetic-run.xlsx");
  assert.equal(f.childCalls.length, 1);
  assert.equal(f.childCalls[0].runId, "synthetic-run"); assert.equal(f.childCalls[0].contents, "report");
  assert.ok(f.childCalls[0].selected.timeoutMs > 0 && f.childCalls[0].selected.timeoutMs <= 3500);
  assert.equal(f.saves(), 0); assert.equal(f.objects.length, 0); assert.equal(f.writes.length, 0);
});

test("scoped child failure does not fallback, log provider details or change stable 400-row key", async () => {
  const failed = fixture({ privateDir: "/fixture-bucket/private", childFails: true });
  const csv = "id,status\n" + Array.from({ length: 400 }, (_, i) => `synthetic-${i},pending`).join("\n");
  await assert.rejects(scoped(() => failed.storage.writeReport("stable-run", csv)), /report_storage_write_failed/);
  const retry = fixture({ privateDir: "/fixture-bucket/private" });
  assert.equal(await scoped(() => retry.storage.writeReport("stable-run", csv)), "objstore://weekly-push-reports/stable-run.csv");
  assert.equal(failed.childCalls[0].runId, retry.childCalls[0].runId);
  assert.equal(failed.childCalls[0].contents, retry.childCalls[0].contents);
  assert.equal(failed.writes.length, 0); assert.equal(failed.logs.length, 0);
});

test("dedicated child durable API uses stable SDK save key/timeout and statically rejects failure", async () => {
  const f = fixture({ privateDir: "/fixture-bucket/private" });
  assert.equal(await f.storage.writeDurableReportInChild("stable-run", Buffer.from("report"), "csv", 2000), "objstore://weekly-push-reports/stable-run.csv");
  assert.deepEqual(f.objects, ["fixture-bucket/private/weekly-push-reports/stable-run.csv"]);
  assert.equal(f.saveOptions[0].timeout, 2000); assert.equal(f.saveOptions[0].resumable, false);
  const failed = fixture({ privateDir: "/fixture-bucket/private", saveFails: true });
  await assert.rejects(failed.storage.writeDurableReportInChild("stable-run", Buffer.from("report"), "csv", 2000),
    (error: any) => error.message === "report_storage_write_failed");
  assert.equal(failed.logs.length, 0); assert.equal(failed.writes.length, 0);
});

test("unscoped save and local fallback preserve the original writeReport contract", async () => {
  const durable = fixture({ privateDir: "/fixture-bucket/private" });
  assert.equal(await durable.storage.writeReport("synthetic-run", "report", "xlsx"), "objstore://weekly-push-reports/synthetic-run.xlsx");
  assert.equal(durable.saves(), 1); assert.equal(durable.childCalls.length, 0);
  assert.equal("timeout" in durable.saveOptions[0], false);
  const failed = fixture({ privateDir: "/fixture-bucket/private", saveFails: true });
  assert.equal(await failed.storage.writeReport("synthetic-run", "report"), failed.storage.reportPathFor("synthetic-run"));
  assert.equal(failed.saves(), 1); assert.equal(failed.writes.length, 1);
  const local = fixture();
  assert.equal(await local.storage.writeReport("synthetic-run", "report"), local.storage.reportPathFor("synthetic-run"));
  assert.equal(local.writes.length, 1); assert.equal(local.objects.length, 0);
});
