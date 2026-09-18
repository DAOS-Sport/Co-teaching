import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

const server = new Server(
  { name: "replit-agent-workspace", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return textResult(await callTool(request.params.name, request.params.arguments || {}));
  } catch (error) {
    return errorResult(error);
  }
});

const transport = new StdioServerTransport();
transport.onerror = (error) => {
  console.error("[claude-mcp] transport error:", error);
};

console.error("[claude-mcp] workspace MCP started");
await server.connect(transport);