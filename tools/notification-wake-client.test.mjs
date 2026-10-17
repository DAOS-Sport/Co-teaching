import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NOTIFICATION_WAKE_ENDPOINT, runNotificationWake } from "./notification-wake-client.mjs";

const env = {
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "DAOS-Sport/Co-teaching",
  GITHUB_REPOSITORY_ID: "1223131954", GITHUB_REPOSITORY_OWNER_ID: "278040315",
  GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule",
  GITHUB_WORKFLOW_REF: "DAOS-Sport/Co-teaching/.github/workflows/notification-wake.yml@refs/heads/main",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/test?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-runtime-credential",
};
function harness(replies) {
  let clock = 0;
  let requests = 0;
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    assert.equal(init.redirect, "error");
    if (url.hostname.endsWith(".actions.githubusercontent.com")) {
      assert.equal(url.searchParams.get("audience"), NOTIFICATION_WAKE_ENDPOINT);
      assert.equal(init.headers.authorization, `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`);
      return Response.json({ value: "fixture.short.token" });
    }
    assert.equal(url.href, "https://swim-scheduler-ronchen2.replit.app/api/internal/notification-wake");
    assert.equal(init.method, "POST");
    assert.equal(init.body, '{"version":1}');
    assert.equal(init.headers.authorization, "Bearer fixture.short.token");
    const reply = replies[Math.min(requests++, replies.length - 1)];
    return typeof reply === "number" ? new Response("private upstream details", { status: reply }) : Response.json(reply);
  };
  return { options: { env, fetch: fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; } }, calls, requests: () => requests };
}
const drained = { version: 1, status: "drained", remainingWork: false, processed: 2, failed: 0 };

test("obtains fresh runtime tokens and drains remaining work with only aggregate output", async () => {
  const h = harness([{ ...drained, status: "remaining", remainingWork: true }, drained]);
  assert.deepEqual(await runNotificationWake(h.options), { version: 1, status: "drained", requests: 2, processed: 4, failed: 0, retries: 0 });
  assert.equal(h.calls.length, 4);
});
test("409, 429, 503 and busy use bounded retry", async () => {
  const h = harness([409, 429, 503, { ...drained, status: "busy", remainingWork: true }, drained]);
  const result = await runNotificationWake(h.options);
  assert.equal(result.status, "drained");
  assert.equal(result.retries, 4);
  assert.equal(result.processed, 2);
});
test("deadlines and request/retry bounds produce explicit incomplete aggregates", async () => {
  const h = harness([{ ...drained, status: "remaining", remainingWork: true }]);
  const result = await runNotificationWake({ ...h.options, maxRequests: 2 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.code, "WAKE_REQUEST_LIMIT");
  assert.equal(result.requests, 2);
  const b = harness([503]);
  assert.equal((await runNotificationWake({ ...b.options, maxRetries: 1 })).code, "WAKE_RETRY_LIMIT");
  const d = harness([503]);
  assert.equal((await runNotificationWake({ ...d.options, totalDeadlineMs: 500 })).code, "WAKE_DEADLINE");
});
test("untrusted runner/repository/ref/event/workflow/runtime origin fail before outbound calls", async () => {
  for (const changed of [
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "fork/Co-teaching" }, { GITHUB_REPOSITORY_ID: "1" },
    { GITHUB_REPOSITORY_OWNER_ID: "1" }, { GITHUB_REF: "refs/heads/feature" }, { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_WORKFLOW_REF: "DAOS-Sport/Co-teaching/.github/workflows/other.yml@refs/heads/main" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.invalid/oidc" }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" },
  ]) {
    const h = harness([drained]);
    const result = await runNotificationWake({ ...h.options, env: { ...env, ...changed } });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, "ACTIONS_IDENTITY_REJECTED");
    assert.equal(h.calls.length, 0);
  }
});
test("bad response and fatal HTTP never expose body or tokens", async () => {
  for (const reply of [401, 302, { ...drained, remainingWork: true }, { ...drained, processed: -1 }, { token: "private" }]) {
    const h = harness([reply]);
    const result = await runNotificationWake(h.options);
    assert.equal(result.status, "incomplete");
    assert.doesNotMatch(JSON.stringify(result), /private|fixture|Bearer/);
  }
});
test("hanging fetch has a bounded deadline and is incomplete", async () => {
  const result = await runNotificationWake({ env, fetch: () => new Promise(() => {}), httpDeadlineMs: 20 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.code, "OIDC_REQUEST_FAILED");
});
test("workflow runs tested driver inline without checkout, secrets or arbitrary URL inputs", () => {
  const source = readFileSync(new URL("./notification-wake-client.mjs", import.meta.url), "utf8").trimEnd();
  const workflow = readFileSync(new URL("../.github/workflows/notification-wake.yml", import.meta.url), "utf8");
  const template = readFileSync(new URL("../docs/examples/notification-wake.workflow.yml.disabled", import.meta.url), "utf8");
  assert.ok(workflow.includes(source.split("\n").map((line) => `          ${line}`).join("\n")));
  assert.ok(workflow.includes("vars.NOTIFICATION_WAKE_ENABLED == 'true'"));
  assert.match(workflow, /contents: none/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /^\s*(?:-\s*)?(?:uses|pull_request|push|inputs):|\$\{\{\s*secrets\./m);
  assert.match(template, /if: \$\{\{ false \}\}/);
});

test("real file and inline Node entrypoints fail closed outside Actions without network", () => {
  const source = readFileSync(new URL("./notification-wake-client.mjs", import.meta.url), "utf8");
  const direct = spawnSync(process.execPath, [fileURLToPath(new URL("./notification-wake-client.mjs", import.meta.url))], {
    encoding: "utf8", env: { GITHUB_ACTIONS: "false" }, timeout: 3000,
  });
  assert.equal(direct.status, 1);
  assert.equal(JSON.parse(direct.stdout).code, "ACTIONS_IDENTITY_REJECTED");
  assert.equal(direct.stderr, "");
  const inline = spawnSync(process.execPath, ["--input-type=module"], {
    input: `${source}\nconst outcome = await runNotificationWake(); console.log(JSON.stringify(outcome)); if (outcome.status !== 'drained') process.exitCode = 1;`,
    encoding: "utf8", env: { GITHUB_ACTIONS: "false" }, timeout: 3000,
  });
  assert.equal(inline.status, 1);
  assert.equal(JSON.parse(inline.stdout).code, "ACTIONS_IDENTITY_REJECTED");
  assert.equal(inline.stderr, "");
});
