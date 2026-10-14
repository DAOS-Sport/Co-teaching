import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callSchedulingTool, schedulingTools } from "./schedulingTools";
import {
  SCHEDULING_MCP_PATH,
  SCHEDULING_MCP_SCOPE,
  schedulingOAuthProvider,
  schedulingResourceMetadataUrl,
  schedulingResourceUrl,
} from "./schedulingOAuth";

const TOKEN_ENV_NAME = "GROK_SCHEDULING_TOKEN";

/**
 * Domain-scoped MCP endpoint for Grok and other scheduling assistants.
 * It deliberately exposes scheduling operations only; workspace files,
 * shell commands, environment variables and arbitrary SQL are unavailable.
 */
export function registerSchedulingMcpRoutes(app: Express): void {
  app.options(SCHEDULING_MCP_PATH, (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.sendStatus(204);
  });

  app.get(SCHEDULING_MCP_PATH, (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "Scheduling MCP endpoint accepts POST requests only" });
  });

  app.post(SCHEDULING_MCP_PATH, async (req, res) => {
    if (!(await isAuthorized(req))) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${schedulingResourceMetadataUrl()}", scope="${SCHEDULING_MCP_SCOPE}"`,
      );
      res.status(401).json({
        error: "invalid_token",
        error_description: "Scheduling MCP authentication required",
      });
      return;
    }

    const server = createSchedulingServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch((error) => {
        console.error("[scheduling-mcp] transport close failed:", error);
      });
    });

    try {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schedulingTools }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name;
        const startedAt = Date.now();
        try {
          const result = await callSchedulingTool(toolName, request.params.arguments || {});
          console.info(JSON.stringify({
            event: "scheduling_mcp_tool_call",
            tool: toolName,
            success: true,
            durationMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          }));
          return textResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(JSON.stringify({
            event: "scheduling_mcp_tool_call",
            tool: toolName,
            success: false,
            error: message,
            durationMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          }));
          return textResult({ error: message }, true);
        }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[scheduling-mcp] request failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "Scheduling MCP request failed" });
    } finally {
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });

  console.log(`[scheduling-mcp] Streamable HTTP endpoint registered at ${SCHEDULING_MCP_PATH}`);
}

function createSchedulingServer(): Server {
  return new Server(
    { name: "swim-scheduling-admin", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
}

function getSchedulingToken(): string | null {
  const token = process.env[TOKEN_ENV_NAME];
  if (!token || Buffer.byteLength(token, "utf8") < 32) return null;
  if (/[\s\x00-\x1f\x7f]/.test(token)) return null;
  return token;
}

async function isAuthorized(req: Request): Promise<boolean> {
  const authorization = req.get("authorization");
  const match = authorization ? /^Bearer ([^\s,]+)$/.exec(authorization) : null;
  if (!match) return false;

  const expected = getSchedulingToken();
  if (expected) {
    const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
    const providedDigest = createHash("sha256").update(match[1], "utf8").digest();
    if (timingSafeEqual(expectedDigest, providedDigest)) return true;
  }

  try {
    const auth = await schedulingOAuthProvider.verifyAccessToken(match[1]);
    return auth.scopes.includes(SCHEDULING_MCP_SCOPE)
      && auth.resource?.href === schedulingResourceUrl().href;
  } catch {
    return false;
  }
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
