import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export const GITHUB_WAKE_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_WAKE_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
export const NOTIFICATION_WAKE_AUDIENCE = "https://swim-scheduler-ronchen2.replit.app/api/internal/notification-wake";
const repository = "DAOS-Sport/Co-teaching";
const ref = "refs/heads/main";
const workflowRef = `${repository}/.github/workflows/notification-wake.yml@${ref}`;
const defaultSubject = `repo:${repository}:ref:${ref}`;
const CACHE_MS = 300_000;
const REFRESH_COOLDOWN_MS = 30_000;
const MAX_TOKEN_SECONDS = 600;

type ErrorCode = "WAKE_DISABLED" | "WAKE_CONFIG_INVALID" | "AUTHORIZATION_REQUIRED" |
  "JWT_MALFORMED" | "JWT_ALGORITHM_REJECTED" | "JWT_CLAIMS_REJECTED" |
  "JWKS_UNAVAILABLE" | "JWKS_INVALID" | "JWT_KEY_REJECTED" | "JWT_SIGNATURE_REJECTED";

export class GithubWakeIdentityError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = "GithubWakeIdentityError"; }
}
export interface GithubWakeIdentityConfig {
  enabled: boolean;
  audience: string;
  repositoryId: string;
  repositoryOwnerId: string;
  subject: string;
}
export interface GithubWakeIdentity {
  repositoryId: string;
  repositoryOwnerId: string;
  repository: string;
  ref: string;
  workflowRef: string;
  eventName: "schedule" | "workflow_dispatch";
  subject: string;
  runId: string;
  runAttempt: string;
}
export interface GithubWakeIdentityDependencies {
  fetch?: typeof fetch;
  /** Trusted server time in milliseconds. */
  now?: () => number;
  /** Test/host may shorten, never enlarge the five-second JWKS bound. */
  jwksTimeoutMs?: number;
}
function fail(code: ErrorCode): never { throw new GithubWakeIdentityError(code); }
const positiveId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,29}$/.test(value);
function validateConfig(config: GithubWakeIdentityConfig) {
  if (config.audience !== NOTIFICATION_WAKE_AUDIENCE || !positiveId(config.repositoryId) ||
    !positiveId(config.repositoryOwnerId) || typeof config.subject !== "string" ||
    config.subject.length > 1024 || !config.subject.startsWith(`repo:${repository}:`) || /[\r\n*]/.test(config.subject)) {
    fail("WAKE_CONFIG_INVALID");
  }
}
export function parseGithubWakeIdentityConfig(env: Record<string, string | undefined>): GithubWakeIdentityConfig {
  const enabledValue = env.NOTIFICATION_WAKE_ENABLED;
  if (enabledValue !== undefined && enabledValue !== "true" && enabledValue !== "false") fail("WAKE_CONFIG_INVALID");
  const config: GithubWakeIdentityConfig = {
    enabled: enabledValue === "true",
    audience: env.NOTIFICATION_WAKE_AUDIENCE ?? (enabledValue === "true" ? "" : NOTIFICATION_WAKE_AUDIENCE),
    repositoryId: env.NOTIFICATION_WAKE_REPOSITORY_ID ?? "1223131954",
    repositoryOwnerId: env.NOTIFICATION_WAKE_REPOSITORY_OWNER_ID ?? "278040315",
    subject: env.NOTIFICATION_WAKE_SUBJECT ?? defaultSubject,
  };
  validateConfig(config);
  return Object.freeze(config);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decode(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail("JWT_MALFORMED");
  try {
    const bytes = Buffer.from(segment, "base64url");
    if (bytes.toString("base64url") !== segment) fail("JWT_MALFORMED");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(value)) fail("JWT_MALFORMED");
    return value;
  } catch { return fail("JWT_MALFORMED"); }
}
function verifyClaims(claims: Record<string, unknown>, config: GithubWakeIdentityConfig, now: number): GithubWakeIdentity {
  const { iat, nbf, exp } = claims;
  if (!Number.isFinite(now) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) ||
    (iat as number) > now || (nbf as number) > now || (exp as number) <= now ||
    (exp as number) <= (iat as number) || (nbf as number) >= (exp as number) ||
    (exp as number) - (iat as number) > MAX_TOKEN_SECONDS || now - (iat as number) > MAX_TOKEN_SECONDS ||
    claims.iss !== GITHUB_WAKE_ISSUER || claims.aud !== config.audience ||
    claims.repository !== repository || claims.repository_id !== config.repositoryId ||
    claims.repository_owner_id !== config.repositoryOwnerId || claims.ref !== ref ||
    claims.workflow_ref !== workflowRef || claims.sub !== config.subject ||
    (claims.event_name !== "schedule" && claims.event_name !== "workflow_dispatch") ||
    !positiveId(claims.run_id) || !positiveId(claims.run_attempt)) fail("JWT_CLAIMS_REJECTED");
  return {
    repositoryId: config.repositoryId, repositoryOwnerId: config.repositoryOwnerId,
    repository, ref, workflowRef, eventName: claims.event_name,
    subject: config.subject, runId: claims.run_id, runAttempt: claims.run_attempt,
  };
}
type KeyCache = { keys: Map<string, KeyObject>; expiresAt: number; lastRefreshAt: number; pending?: Promise<void>; lastError?: ErrorCode };
const caches = new WeakMap<typeof fetch, KeyCache>();
function cacheFor(fetchImpl: typeof fetch): KeyCache {
  let cache = caches.get(fetchImpl);
  if (!cache) { cache = { keys: new Map(), expiresAt: 0, lastRefreshAt: -Infinity }; caches.set(fetchImpl, cache); }
  return cache;
}
async function limitedJson(response: Response): Promise<unknown> {
  if (!response.body) fail("JWKS_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131_072) fail("JWKS_INVALID");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof GithubWakeIdentityError) throw error;
    return fail("JWKS_INVALID");
  } finally { reader.releaseLock(); }
}
function publicKeys(document: unknown): Map<string, KeyObject> {
  if (!object(document) || !Array.isArray(document.keys) || document.keys.length === 0 || document.keys.length > 64) fail("JWKS_INVALID");
  const keys = new Map<string, KeyObject>();
  for (const jwk of document.keys) {
    if (!object(jwk) || jwk.kty !== "RSA" || (jwk.alg !== undefined && jwk.alg !== "RS256") ||
      (jwk.use !== undefined && jwk.use !== "sig")) continue;
    if (typeof jwk.kid !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(jwk.kid) || keys.has(jwk.kid) ||
      typeof jwk.n !== "string" || !/^[A-Za-z0-9_-]+$/.test(jwk.n) || jwk.n.length > 2048 ||
      typeof jwk.e !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(jwk.e) || jwk.d !== undefined ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")))) fail("JWKS_INVALID");
    try {
      const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" });
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail("JWKS_INVALID");
      keys.set(jwk.kid, key);
    } catch { fail("JWKS_INVALID"); }
  }
  if (keys.size === 0) fail("JWKS_INVALID");
  return keys;
}
async function refresh(cache: KeyCache, fetchImpl: typeof fetch, now: () => number, timeoutMs: number) {
  if (cache.pending) return cache.pending;
  cache.lastRefreshAt = now();
  cache.pending = (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const keys = await Promise.race([
        (async () => {
          const response = await fetchImpl(GITHUB_WAKE_JWKS_URL, {
            method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
            headers: { accept: "application/json" }, signal: controller.signal,
          });
          if (response.status !== 200 || response.redirected) fail("JWKS_UNAVAILABLE");
          return publicKeys(await limitedJson(response));
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new GithubWakeIdentityError("JWKS_UNAVAILABLE")); }, timeoutMs);
        }),
      ]);
      cache.keys = keys;
      cache.expiresAt = now() + CACHE_MS;
      cache.lastError = undefined;
    } catch (error) {
      cache.keys = new Map(); cache.expiresAt = 0;
      cache.lastError = error instanceof GithubWakeIdentityError ? error.code : "JWKS_UNAVAILABLE";
      fail(cache.lastError);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  })();
  try { await cache.pending; } finally { cache.pending = undefined; }
}

/** No product imports or side effects; failure contains only a static error code. */
export async function verifyGithubWakeIdentity(
  authorization: string | undefined,
  config: GithubWakeIdentityConfig,
  dependencies: GithubWakeIdentityDependencies = {},
): Promise<GithubWakeIdentity> {
  if (config.enabled !== true) fail("WAKE_DISABLED");
  validateConfig(config);
  if (!authorization) fail("AUTHORIZATION_REQUIRED");
  if (authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) fail("JWT_MALFORMED");
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3) fail("JWT_MALFORMED");
  const header = decode(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid) ||
    (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined || header.jku !== undefined ||
    header.x5u !== undefined || header.jwk !== undefined) fail("JWT_ALGORITHM_REJECTED");
  const now = dependencies.now ?? Date.now;
  const identity = verifyClaims(decode(parts[1]), config, now() / 1000);
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) fail("JWT_MALFORMED");
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.toString("base64url") !== parts[2] || signature.length < 256 || signature.length > 1024) fail("JWT_MALFORMED");
  const fetchImpl = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.jwksTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) fail("WAKE_CONFIG_INVALID");
  const cache = cacheFor(fetchImpl);
  if (cache.lastError && !cache.pending && now() - cache.lastRefreshAt < REFRESH_COOLDOWN_MS) fail(cache.lastError);
  let refreshed = false;
  if (cache.expiresAt <= now() || cache.keys.size === 0) { await refresh(cache, fetchImpl, now, timeoutMs); refreshed = true; }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  let key = cache.keys.get(header.kid);
  let valid = key ? verify("RSA-SHA256", signed, key, signature) : false;
  if (!valid && !refreshed && now() - cache.lastRefreshAt >= REFRESH_COOLDOWN_MS) {
    await refresh(cache, fetchImpl, now, timeoutMs);
    key = cache.keys.get(header.kid);
    valid = key ? verify("RSA-SHA256", signed, key, signature) : false;
  }
  if (!key) fail("JWT_KEY_REJECTED");
  if (!valid) fail("JWT_SIGNATURE_REJECTED");
  // Recheck expiry after network work; it cannot expire while awaiting JWKS and still pass.
  verifyClaims(decode(parts[1]), config, now() / 1000);
  return identity;
}
