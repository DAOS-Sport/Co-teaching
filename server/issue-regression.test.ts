import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
