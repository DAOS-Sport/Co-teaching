import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  GITHUB_WAKE_JWKS_URL,
  GithubWakeIdentityError,
  parseGithubWakeIdentityConfig,
  verifyGithubWakeIdentity,
} from "./githubWakeIdentity";

const now = 1_792_187_200_000;
const config = parseGithubWakeIdentityConfig({
  NOTIFICATION_WAKE_ENABLED: "true",
  NOTIFICATION_WAKE_AUDIENCE: "https://swim-scheduler-ronchen2.replit.app/api/internal/notification-wake",
});
const keys = ["old-key", "new-key"].map((kid) => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { ...pair, jwk: { ...pair.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
});
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: config.audience,
  iat: now / 1000 - 10,
  nbf: now / 1000 - 10,
  exp: now / 1000 + 290,
  repository: "DAOS-Sport/Co-teaching",
  repository_id: "1223131954",
  repository_owner_id: "278040315",
  ref: "refs/heads/main",
  workflow_ref: "DAOS-Sport/Co-teaching/.github/workflows/notification-wake.yml@refs/heads/main",
  event_name: "schedule",
  sub: "repo:DAOS-Sport/Co-teaching:ref:refs/heads/main",
  run_id: "1234567",
  run_attempt: "1",
};
function token(overrides: Record<string, unknown> = {}, key = keys[0], header: Record<string, unknown> = {}) {
  const parts = [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.jwk.kid, ...header })).toString("base64url"),
    Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString("base64url"),
  ];
  const input = parts.join(".");
  return `Bearer ${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}
function harness(sets: unknown[] = [{ keys: [keys[0].jwk] }]) {
  let calls = 0;
  let clock = now;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), GITHUB_WAKE_JWKS_URL);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const document = sets[Math.min(calls++, sets.length - 1)];
    return new Response(JSON.stringify(document), { headers: { "content-type": "application/json" } });
  };
  return { deps: { fetch: fetchImpl as typeof fetch, now: () => clock }, count: () => calls, advance: (ms: number) => { clock += ms; } };
}
async function rejected(auth: string | undefined, code: string, overrides: Record<string, unknown> = {}, deps = harness().deps) {
  await assert.rejects(verifyGithubWakeIdentity(auth, { ...config, ...overrides }, deps), (error: unknown) => {
    assert.ok(error instanceof GithubWakeIdentityError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(JSON.stringify(error).includes("Bearer"), false);
    return true;
  });
}

test("real RSA signature returns bounded claim metadata and caches trusted JWKS", async () => {
  const h = harness();
  const identity = await verifyGithubWakeIdentity(token(), config, h.deps);
  assert.deepEqual(identity, {
    repositoryId: claims.repository_id, repositoryOwnerId: claims.repository_owner_id,
    repository: claims.repository, ref: claims.ref, workflowRef: claims.workflow_ref,
    eventName: "schedule", subject: claims.sub, runId: claims.run_id, runAttempt: claims.run_attempt,
  });
  await verifyGithubWakeIdentity(token({ event_name: "workflow_dispatch" }), config, h.deps);
  assert.equal(h.count(), 1);
});

test("disabled and invalid config reject before network", async () => {
  const h = harness();
  assert.equal(parseGithubWakeIdentityConfig({}).enabled, false);
  await rejected(token(), "WAKE_DISABLED", { enabled: false }, h.deps);
  await rejected(token(), "WAKE_CONFIG_INVALID", { audience: "http://invalid.test/api/internal/notification-wake" }, h.deps);
  assert.equal(h.count(), 0);
  assert.throws(() => parseGithubWakeIdentityConfig({ NOTIFICATION_WAKE_ENABLED: "true" }), /WAKE_CONFIG_INVALID/);
  assert.throws(() => parseGithubWakeIdentityConfig({ NOTIFICATION_WAKE_ENABLED: "TRUE" }), /WAKE_CONFIG_INVALID/);
});

for (const [field, value] of [
  ["iss", "https://attacker.invalid"], ["aud", "other-audience"], ["aud", [claims.aud]],
  ["repository_id", "1"], ["repository_owner_id", "1"], ["repository", "fork/Co-teaching"],
  ["ref", "refs/heads/feature"], ["ref", "refs/pull/1/merge"],
  ["workflow_ref", "DAOS-Sport/Co-teaching/.github/workflows/other.yml@refs/heads/main"],
  ["event_name", "pull_request"], ["event_name", "push"],
  ["sub", "repo:DAOS-Sport/Co-teaching:pull_request"], ["sub", "repo:DAOS-Sport/Co-teaching:environment:production"],
  ["exp", now / 1000], ["exp", now / 1000 - 1], ["exp", now / 1000 + 3600],
  ["nbf", now / 1000 + 1], ["iat", now / 1000 + 1], ["iat", now / 1000 - 601],
  ["nbf", undefined], ["iat", "123"], ["run_id", "not-a-run"], ["run_attempt", "0"],
] as const) {
  test(`rejects untrusted claim ${field}=${JSON.stringify(value)}`, async () => {
    const h = harness();
    await rejected(token({ [field]: value }), "JWT_CLAIMS_REJECTED", {}, h.deps);
    assert.equal(h.count(), 0);
  });
}

test("rejects malformed, unsigned, wrong algorithm and tampered signatures", async () => {
  await rejected(undefined, "AUTHORIZATION_REQUIRED");
  for (const value of ["Basic test", "Bearer a.b", "Bearer a.b.c", `${token()} extra`, `Bearer ${"a".repeat(17000)}`]) {
    await rejected(value, "JWT_MALFORMED");
  }
  for (const alg of ["none", "HS256", "RS512"]) {
    await rejected(token({}, keys[0], { alg }), "JWT_ALGORITHM_REJECTED");
  }
  await rejected(token({}, keys[0], { jku: "https://attacker.invalid/keys" }), "JWT_ALGORITHM_REJECTED");
  const h = harness();
  await rejected(token({}, keys[1], { kid: keys[0].jwk.kid }), "JWT_SIGNATURE_REJECTED", {}, h.deps);
});

test("unknown and same-kid rotation refresh once after bounded cooldown", async () => {
  const h = harness([{ keys: [keys[0].jwk] }, { keys: [keys[1].jwk] }]);
  await verifyGithubWakeIdentity(token(), config, h.deps);
  h.advance(31_000);
  await verifyGithubWakeIdentity(token({}, keys[1]), config, h.deps);
  assert.equal(h.count(), 2);
  const changed = { ...keys[1], jwk: { ...keys[1].jwk, kid: keys[0].jwk.kid } };
  const same = harness([{ keys: [keys[0].jwk] }, { keys: [changed.jwk] }]);
  await verifyGithubWakeIdentity(token(), config, same.deps);
  same.advance(31_000);
  await verifyGithubWakeIdentity(token({}, changed), config, same.deps);
  assert.equal(same.count(), 2);
});

test("bad kid cannot force unbounded key refreshes during cooldown", async () => {
  const h = harness();
  await verifyGithubWakeIdentity(token(), config, h.deps);
  for (let i = 0; i < 3; i++) await rejected(token({}, keys[1]), "JWT_KEY_REJECTED", {}, h.deps);
  assert.equal(h.count(), 1);
});

test("JWKS failure, redirect, malformed/private/weak/duplicate keys fail closed", async () => {
  for (const document of [null, {}, { keys: [] }, { keys: [keys[0].jwk, keys[0].jwk] },
    { keys: [{ ...keys[0].jwk, d: "private" }] }, { keys: [{ ...keys[0].jwk, n: "AQAB" }] }]) {
    await rejected(token(), "JWKS_INVALID", {}, harness([document]).deps);
  }
  await rejected(token(), "JWKS_UNAVAILABLE", {}, {
    fetch: async () => new Response("no", { status: 503 }), now: () => now,
  } as any);
  await rejected(token(), "JWKS_UNAVAILABLE", {}, {
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid/keys" } }), now: () => now,
  } as any);
  await rejected(token(), "JWKS_UNAVAILABLE", {}, {
    fetch: async () => { throw new Error("sensitive upstream response"); }, now: () => now,
  } as any);
});

test("unresponsive JWKS has a hard deadline even when fetch ignores abort", async () => {
  const started = Date.now();
  await rejected(token(), "JWKS_UNAVAILABLE", {}, {
    fetch: () => new Promise(() => {}), now: () => now, jwksTimeoutMs: 20,
  } as any);
  assert.ok(Date.now() - started < 1000);
});

test("explicit immutable subject config is exact and never broadens to any repo subject", async () => {
  const subject = "repo:DAOS-Sport/Co-teaching:repository_id:1223131954:ref:refs/heads/main";
  const custom = parseGithubWakeIdentityConfig({
    NOTIFICATION_WAKE_ENABLED: "true", NOTIFICATION_WAKE_AUDIENCE: config.audience,
    NOTIFICATION_WAKE_SUBJECT: subject,
  });
  await verifyGithubWakeIdentity(token({ sub: subject }), custom, harness().deps);
  await rejected(token(), "JWT_CLAIMS_REJECTED", { subject });
});

test("failed JWKS is cooled down and concurrent requests share one fetch", async () => {
  let calls = 0;
  let clock = now;
  const deps = { now: () => clock, fetch: async () => { calls++; return new Response("no", { status: 503 }); } } as any;
  await Promise.all(Array.from({ length: 5 }, () => rejected(token(), "JWKS_UNAVAILABLE", {}, deps)));
  await rejected(token(), "JWKS_UNAVAILABLE", {}, deps);
  assert.equal(calls, 1);
  clock += 31_000;
  await rejected(token(), "JWKS_UNAVAILABLE", {}, deps);
  assert.equal(calls, 2);
});

test("JWT expiration is rechecked after JWKS and oversized documents are rejected", async () => {
  let clock = now;
  const deps = {
    now: () => clock,
    fetch: async () => { clock += 300_000; return Response.json({ keys: [keys[0].jwk] }); },
  } as any;
  await rejected(token(), "JWT_CLAIMS_REJECTED", {}, deps);
  await rejected(token(), "JWKS_INVALID", {}, {
    now: () => now, fetch: async () => new Response(" ".repeat(131073)),
  } as any);
});
