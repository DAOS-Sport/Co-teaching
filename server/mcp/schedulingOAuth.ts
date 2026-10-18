import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { db } from "../db";
import { env } from "../config/env";
import { verifyAdminPassword } from "../shared/auth/adminPassword";
import {
  mcpOauthClients,
  mcpOauthCodes,
  mcpOauthTokens,
} from "@shared/schema";

export const SCHEDULING_MCP_PATH = "/api/grok-scheduling-mcp";
export const SCHEDULING_MCP_SCOPE = "scheduling:manage";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

function publicOrigin(): URL {
  const origin = new URL(env.publicOrigin);
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return origin;
}

export function schedulingResourceUrl(): URL {
  return new URL(SCHEDULING_MCP_PATH, publicOrigin());
}

export function schedulingResourceMetadataUrl(): string {
  return new URL("/.well-known/oauth-protected-resource", publicOrigin()).href;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeScopes(scopes?: string[]): string[] {
  const requested = scopes && scopes.length > 0 ? scopes : [SCHEDULING_MCP_SCOPE];
  if (requested.some((scope) => scope !== SCHEDULING_MCP_SCOPE)) {
    throw new InvalidScopeError("Only scheduling:manage is supported");
  }
  return Array.from(new Set(requested));
}

function normalizeResource(resource?: URL): string {
  const expected = schedulingResourceUrl().href;
  if (resource && resource.href !== expected) {
    throw new InvalidTargetError(`Unsupported resource: ${resource.href}`);
  }
  return expected;
}

function asClient(value: unknown): OAuthClientInformationFull | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as OAuthClientInformationFull;
}

function asScopes(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

class SchedulingClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const [row] = await db
      .select({ clientData: mcpOauthClients.clientData })
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.clientId, clientId))
      .limit(1);
    return asClient(row?.clientData);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    // PKCE protects public MCP clients. Dropping generated client secrets keeps
    // credentials out of the database and avoids secret rotation failures.
    const publicClient: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      client_secret: undefined,
      client_secret_expires_at: undefined,
    };
    await db.insert(mcpOauthClients).values({
      clientId: publicClient.client_id,
      clientData: publicClient,
    });
    return publicClient;
  }
}

export class SchedulingOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new SchedulingClientsStore();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const scopes = normalizeScopes(params.scopes);
    const resource = normalizeResource(params.resource);
    const req = res.req as Request;

    // Only accept the password from a POST body. Never allow approval from a
    // query parameter, where credentials can leak into browser/server logs.
    if (req.method !== "POST" || !verifyAdminPassword(req)) {
      renderAuthorizationPage(res, client, req.method === "POST");
      return;
    }

    const code = opaqueToken();
    await db.insert(mcpOauthCodes).values({
      codeHash: digest(code),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      resource,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
    });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const [row] = await db
      .select()
      .from(mcpOauthCodes)
      .where(and(
        eq(mcpOauthCodes.codeHash, digest(authorizationCode)),
        eq(mcpOauthCodes.clientId, client.client_id),
        isNull(mcpOauthCodes.consumedAt),
        gt(mcpOauthCodes.expiresAt, new Date()),
      ))
      .limit(1);
    if (!row) throw new InvalidGrantError("Authorization code is invalid or expired");
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const now = new Date();
    const [row] = await db
      .update(mcpOauthCodes)
      .set({ consumedAt: now })
      .where(and(
        eq(mcpOauthCodes.codeHash, digest(authorizationCode)),
        eq(mcpOauthCodes.clientId, client.client_id),
        isNull(mcpOauthCodes.consumedAt),
        gt(mcpOauthCodes.expiresAt, now),
      ))
      .returning();
    if (!row) throw new InvalidGrantError("Authorization code is invalid or already used");
    if (redirectUri && redirectUri !== row.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && resource.href !== row.resource) {
      throw new InvalidTargetError("resource does not match the authorization request");
    }
    return this.issueTokens(client.client_id, asScopes(row.scopes), row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const now = new Date();
    const [row] = await db
      .update(mcpOauthTokens)
      .set({ revokedAt: now })
      .where(and(
        eq(mcpOauthTokens.tokenHash, digest(refreshToken)),
        eq(mcpOauthTokens.tokenType, "refresh"),
        eq(mcpOauthTokens.clientId, client.client_id),
        isNull(mcpOauthTokens.revokedAt),
        gt(mcpOauthTokens.expiresAt, now),
      ))
      .returning();
    if (!row) throw new InvalidGrantError("Refresh token is invalid, expired or already used");

    const grantedScopes = asScopes(row.scopes);
    const requestedScopes = scopes ? normalizeScopes(scopes) : grantedScopes;
    if (requestedScopes.some((scope) => !grantedScopes.includes(scope))) {
      throw new InvalidScopeError("Requested scope exceeds the original grant");
    }
    if (resource && resource.href !== row.resource) {
      throw new InvalidTargetError("resource does not match the original grant");
    }
    return this.issueTokens(client.client_id, requestedScopes, row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [row] = await db
      .select()
      .from(mcpOauthTokens)
      .where(and(
        eq(mcpOauthTokens.tokenHash, digest(token)),
        eq(mcpOauthTokens.tokenType, "access"),
        isNull(mcpOauthTokens.revokedAt),
        gt(mcpOauthTokens.expiresAt, new Date()),
      ))
      .limit(1);
    if (!row) throw new InvalidTokenError("Access token is invalid or expired");

    return {
      token,
      clientId: row.clientId,
      scopes: asScopes(row.scopes),
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
      resource: new URL(row.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await db
      .update(mcpOauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(mcpOauthTokens.tokenHash, digest(request.token)),
        eq(mcpOauthTokens.clientId, client.client_id),
        isNull(mcpOauthTokens.revokedAt),
      ));
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: string,
  ): Promise<OAuthTokens> {
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const now = Date.now();
    await db.insert(mcpOauthTokens).values([
      {
        tokenHash: digest(accessToken),
        tokenType: "access",
        clientId,
        scopes,
        resource,
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
      {
        tokenHash: digest(refreshToken),
        tokenType: "refresh",
        clientId,
        scopes,
        resource,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

export const schedulingOAuthProvider = new SchedulingOAuthProvider();

export function registerSchedulingOAuthRoutes(app: Express): void {
  const issuerUrl = publicOrigin();
  const resourceServerUrl = schedulingResourceUrl();
  const metadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: [SCHEDULING_MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Swim Scheduling Admin MCP",
  };

  // Grok currently probes the root RFC 9728 URL. Also expose the path-scoped
  // URL used by the MCP SDK and newer clients.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(metadata));
  app.get(
    `/.well-known/oauth-protected-resource${SCHEDULING_MCP_PATH}`,
    (_req, res) => res.json(metadata),
  );

  app.use(mcpAuthRouter({
    provider: schedulingOAuthProvider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: [SCHEDULING_MCP_SCOPE],
    resourceName: "Swim Scheduling Admin MCP",
  }));
}

function renderAuthorizationPage(
  res: Response,
  client: OAuthClientInformationFull,
  invalidPassword: boolean,
): void {
  const req = res.req as Request;
  const body = req.method === "POST" ? req.body : req.query;
  const hiddenFields = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "state",
    "resource",
  ]
    .map((name) => {
      const raw = body[name];
      const value = typeof raw === "string" ? raw : "";
      return value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : "";
    })
    .join("\n");
  const clientName = client.client_name || "Grok MCP Connector";
  const redirectHost = safeHostname(client.redirect_uris[0]);
  const authorizationUrl = new URL("/authorize", publicOrigin());
  const allowedFormOrigins = Array.from(new Set([
    authorizationUrl.origin,
    ...client.redirect_uris.flatMap((redirectUri) => {
      try {
        return [new URL(redirectUri).origin];
      } catch {
        return [];
      }
    }),
  ])).join(" ");

  res.status(invalidPassword ? 401 : 200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Cursor and other MCP clients may render this page in a sandboxed webview
  // with an opaque origin. In that context `form-action 'self'` does not match
  // the real HTTPS endpoint. Browsers also apply form-action to the OAuth 302
  // callback, so allow the exact origins from the validated client registration.
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${allowedFormOrigins}; frame-ancestors 'none'`,
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.send(`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>授權 Grok 排班工具</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f7fb;margin:0;padding:32px;color:#172033}
main{max-width:480px;margin:8vh auto;background:white;border-radius:16px;padding:28px;box-shadow:0 8px 30px #14213d1a}
h1{font-size:24px;margin-top:0}p{line-height:1.55}.meta{color:#526071;font-size:14px;background:#f4f6f8;padding:12px;border-radius:8px}
label{display:block;font-weight:650;margin:20px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bac3cf;border-radius:8px;font-size:16px}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#155eef;color:white;font-size:16px;font-weight:700;cursor:pointer}
.error{color:#b42318;background:#fef3f2;padding:10px;border-radius:8px}</style></head>
<body><main><h1>授權 Grok 使用排班工具</h1>
<p>此連線可查詢、新增、修改及刪除課程。請確認要求來自你正在設定的 Grok Connector。</p>
<p class="meta">Client：${escapeHtml(clientName)}<br>回呼位置：${escapeHtml(redirectHost)}</p>
${invalidPassword ? '<p class="error">管理員密碼不正確，請再試一次。</p>' : ""}
<form method="post" action="${escapeHtml(authorizationUrl.href)}">${hiddenFields}
<label for="password">排班系統管理員密碼</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">確認並授權</button></form></main></body></html>`);
}

function safeHostname(value?: string): string {
  try {
    return value ? new URL(value).host : "未知";
  } catch {
    return "未知";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
