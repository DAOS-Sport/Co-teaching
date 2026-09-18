import type { Express, Request } from "express";
import { randomBytes } from "crypto";
import { storage } from "../storage";
import { isAuthenticated } from "../replitAuth";
import { env } from "../config/env";
import { issueCoachSessionToken } from "../shared/auth/coachPortalSession";
import { fetchWithTimeout, parseJsonBody } from "../shared/http/fetchWithTimeout";

const LINE_AUTH_URL = "https://access.line.me/oauth2/v2.1/authorize";
const LINE_TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const LINE_PROFILE_URL = "https://api.line.me/v2/profile";

/**
 * Replit-Auth attaches passport's user object to `req.user`. The shape
 * carries OIDC claims under `claims.sub`. We narrow it explicitly so the
 * route handler stays free of `any`.
 */
type AuthenticatedRequest = Request & {
  user?: { claims?: { sub?: string } };
};

export type LineLoginToken = {
  lineId: string;
  lineName: string;
  linePicture: string;
  expiresAt: number;
  existingCoachUserId?: string;
};

/**
 * In-memory store for short-lived LINE OAuth tokens.
 * Exported so the coach-portal module can consume + delete them after binding.
 */
export const lineLoginTokens = new Map<string, LineLoginToken>();

const lineOAuthStates = new Map<string, number>();

function getLineRedirectUri(): string {
  return `${env.publicOrigin}/api/auth/line/callback`;
}

function generateToken(): string {
  return randomBytes(36).toString("base64url");
}

/**
 * Atomically consume a short-lived LINE login token. Deleting before the
 * caller performs any async work prevents two concurrent requests from
 * replaying the same credential.
 */
export function consumeLineLoginToken(token: string): LineLoginToken | null {
  const data = lineLoginTokens.get(token);
  if (!data) return null;
  lineLoginTokens.delete(token);
  if (Date.now() > data.expiresAt) return null;
  return data;
}

export function registerAuthRoutes(app: Express): void {
  // Replit Auth — current user
  app.get("/api/auth/user", isAuthenticated, async (req, res) => {
    try {
      const userId = (req as AuthenticatedRequest).user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // === LINE Login OAuth 2.0 ===

  app.get("/api/auth/line", (req, res) => {
    const LINE_CLIENT_ID = env.lineChannelId;
    if (!LINE_CLIENT_ID) {
      return res.status(500).json({ message: "LINE Login 尚未設定" });
    }

    const state = generateToken();
    const nonce = generateToken();
    lineOAuthStates.set(state, Date.now() + 10 * 60 * 1000);

    const redirectUri = getLineRedirectUri();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: LINE_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
      scope: "profile openid",
      nonce,
    });

    res.redirect(`${LINE_AUTH_URL}?${params.toString()}`);
  });

  app.get("/api/auth/line/callback", async (req, res) => {
    const { code, state, error: lineError } = req.query;

    if (lineError) {
      console.error("LINE Login error:", lineError);
      return res.redirect("/coach-portal?error=line_denied");
    }

    if (!code || !state) {
      return res.redirect("/coach-portal?error=no_code");
    }

    const stateExpiry = lineOAuthStates.get(state as string);
    if (!stateExpiry || Date.now() > stateExpiry) {
      lineOAuthStates.delete(state as string);
      return res.redirect("/coach-portal?error=invalid_state");
    }
    lineOAuthStates.delete(state as string);

    const LINE_CLIENT_ID = env.lineChannelId;
    const LINE_CLIENT_SECRET = env.lineChannelSecret;

    if (!LINE_CLIENT_ID || !LINE_CLIENT_SECRET) {
      return res.redirect("/coach-portal?error=line_not_configured");
    }

    try {
      const redirectUri = getLineRedirectUri();
      // Task #32: bound the LINE OAuth round-trip; otherwise a stalled
      // LINE token endpoint would hang the user on the redirect callback.
      const tokenRes = await fetchWithTimeout(LINE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: redirectUri,
          client_id: LINE_CLIENT_ID,
          client_secret: LINE_CLIENT_SECRET,
        }),
      });

      if (!tokenRes.ok) {
        console.error(
          `LINE token exchange failed: status=${tokenRes.status} ` +
            `code=${tokenRes.errorCode} body=${tokenRes.body.slice(0, 500)}`,
        );
        return res.redirect("/coach-portal?error=token_failed");
      }

      const tokenData = parseJsonBody<{ access_token: string }>(tokenRes);
      if (!tokenData?.access_token) {
        console.error("LINE token exchange returned no access_token");
        return res.redirect("/coach-portal?error=token_failed");
      }
      const profileRes = await fetchWithTimeout(LINE_PROFILE_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!profileRes.ok) {
        console.error(
          `LINE profile fetch failed: status=${profileRes.status} ` +
            `code=${profileRes.errorCode}`,
        );
        return res.redirect("/coach-portal?error=profile_failed");
      }

      const profile = parseJsonBody<{
        userId: string;
        displayName: string;
        pictureUrl?: string;
      }>(profileRes);
      if (!profile?.userId) {
        console.error("LINE profile fetch returned malformed body");
        return res.redirect("/coach-portal?error=profile_failed");
      }

      const existingUser = await storage.getCoachUserByLineId(profile.userId);
      if (existingUser) {
        // Only a short-lived, one-time exchange code enters the browser URL.
        // The long-lived coach token is returned later in a POST response.
        const token = generateToken();
        lineLoginTokens.set(token, {
          lineId: profile.userId,
          lineName: profile.displayName,
          linePicture: profile.pictureUrl || "",
          existingCoachUserId: existingUser.id,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });
        return res.redirect(
          `/coach-portal#lineLogin=existing&token=${token}`
        );
      }

      const token = generateToken();
      lineLoginTokens.set(token, {
        lineId: profile.userId,
        lineName: profile.displayName,
        linePicture: profile.pictureUrl || "",
        expiresAt: Date.now() + 15 * 60 * 1000,
      });

      return res.redirect(`/coach-portal#lineLogin=new&token=${token}`);
    } catch (error) {
      console.error("LINE Login callback error:", error);
      return res.redirect("/coach-portal?error=callback_failed");
    }
  });

  app.get("/api/auth/line/status", (_req, res) => {
    const configured = !!(env.lineChannelId && env.lineChannelSecret);
    res.json({ configured });
  });

  app.post("/api/auth/line/exchange", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const data = consumeLineLoginToken(token);
    if (!data?.existingCoachUserId) {
      return res.status(400).json({ message: "登入交換碼已過期或已使用" });
    }

    try {
      const user = await storage.getCoachUserById(data.existingCoachUserId);
      if (!user || user.lineId !== data.lineId) {
        return res.status(403).json({ message: "LINE 身分驗證失敗" });
      }
      const coachToken = await issueCoachSessionToken(user.id, data.lineId);
      return res.json({ ...user, coachToken });
    } catch (error) {
      console.error("LINE login exchange error:", error);
      return res.status(500).json({ message: "登入交換失敗，請重新登入" });
    }
  });

  app.post("/api/auth/line/token-info", (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const data = lineLoginTokens.get(token);
    if (!data || Date.now() > data.expiresAt) {
      lineLoginTokens.delete(token);
      return res.status(404).json({ message: "Token 已過期或不存在" });
    }
    res.json({ lineName: data.lineName, linePicture: data.linePicture });
  });
}
