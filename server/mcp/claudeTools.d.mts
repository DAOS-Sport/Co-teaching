import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export const tools: Tool[];
export function callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
export function textResult(value: unknown, isError?: boolean): CallToolResult;
export function errorResult(error: unknown): CallToolResult;
