import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  errorResult,
  textResult,
  tools,
} from "./claudeTools.mjs";

const MCP_PATH = "/api/mcp";

/**
 * Adds a stateless Streamable HTTP MCP endpoint for trusted remote clients.
 *
 * Stateless mode is intentional: autoscale instances cannot safely share an
 * in-memory MCP session map. Each request creates a fresh MCP server and
 * transport, so clients must send initialize on a new connection.
 */
export function registerRemoteMcpRoutes(app: Express): void {
  app.options(MCP_PATH, (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.sendStatus(204);
  });

  app.get(MCP_PATH, (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).json({ error: "MCP endpoint accepts POST requests only" });
  });

  app.post(MCP_PATH, async (req, res) => {
    if (!isAuthorized(req)) {
      const configured = Boolean(getMcpToken());
      res
        .status(configured ? 401 : 503)
        .json({
          error: configured
            ? "MCP authentication required"
            : "MCP remote access is not configured",
        });
      return;
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch((error) => {
        console.error("[remote-mcp] transport close failed:", error);
      });
    });

    try {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          return textResult(
            await callTool(request.params.name, request.params.arguments || {}),
          );
        } catch (error) {
          return errorResult(error);
        }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[remote-mcp] request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request failed" });
      }
    } finally {
      await server.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });

  console.log(`[remote-mcp] Streamable HTTP endpoint registered at ${MCP_PATH}`);
}

function createMcpServer(): Server {
  return new Server(
    { name: "replit-agent-workspace", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
}

function getMcpToken(): string | null {
  const token = process.env.MCP_TOKEN;
  if (!token) return null;
  if (Buffer.byteLength(token, "utf8") < 32) return null;
  if (/[\s\x00-\x1f\x7f]/.test(token)) return null;
  return token;
}

function isAuthorized(req: Request): boolean {
  const expected = getMcpToken();
  if (!expected) return false;

  const authorization = req.get("authorization");
  if (!authorization) return false;
  const match = /^Bearer ([^\s,]+)$/.exec(authorization);
  if (!match) return false;

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(match[1], "utf8").digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}