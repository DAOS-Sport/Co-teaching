import {
  WORKSPACE_ROOT,
  applyWorkspacePatch,
  gitWorkspaceCommand,
  listWorkspaceFiles,
  readWorkspaceFile,
  relativeWorkspacePath,
  runWorkspaceCommand,
  searchWorkspace,
  writeWorkspaceFile,
} from "./workspace.ts";

export const tools = [
  {
    name: "workspace_info",
    title: "Workspace info",
    description:
      "Show the workspace root, current Git branch/status, package scripts, and environment variable names. Values are never returned.",
    inputSchema: objectSchema({}),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "list_files",
    title: "List workspace files",
    description:
      "List files under a workspace-relative directory. By default skips .git, node_modules, dist, and other generated folders.",
    inputSchema: objectSchema({
      path: { type: "string", default: ".", description: "Workspace-relative directory" },
      includeIgnored: {
        type: "boolean",
        default: false,
        description: "Include generated/dependency directories",
      },
      maxResults: { type: "integer", minimum: 1, maximum: 10_000, default: 500 },
    }),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "read_file",
    title: "Read a file",
    description:
      "Read a UTF-8 text file from the workspace and return its SHA-256 hash for safe follow-up edits. Paths must stay inside the workspace.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        maxBytes: { type: "integer", minimum: 1, maximum: 2_000_000, default: 524_288 },
      },
      ["path"],
    ),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "search_files",
    title: "Search files",
    description:
      "Search UTF-8 text files for a literal string or regular expression. Returns matching paths, line numbers, and snippets.",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1 },
        path: { type: "string", default: ".", description: "Workspace-relative directory" },
        isRegex: { type: "boolean", default: false },
        caseSensitive: { type: "boolean", default: false },
        maxResults: { type: "integer", minimum: 1, maximum: 5_000, default: 500 },
      },
      ["query"],
    ),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "write_file",
    title: "Write a file",
    description:
      "Create or replace a UTF-8 file inside the workspace. Use expectedSha256 to prevent overwriting a file that changed after it was read.",
    inputSchema: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string" },
        createDirectories: { type: "boolean", default: false },
        expectedSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      },
      ["path", "content"],
    ),
    annotations: mutatingAnnotations(),
  },
  {
    name: "apply_patch",
    title: "Apply a unified patch",
    description:
      "Validate and apply a standard unified diff with git apply. Paths in the patch must remain inside the workspace.",
    inputSchema: objectSchema(
      { patch: { type: "string", minLength: 1, description: "Standard unified diff text" } },
      ["patch"],
    ),
    annotations: mutatingAnnotations(),
  },
  {
    name: "run_command",
    title: "Run a workspace command",
    description:
      "Run a trusted local shell command for builds, tests, searches, and diagnostics. The shell can access host paths, but receives a scrubbed environment without project secrets.",
    inputSchema: objectSchema(
      {
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", default: ".", description: "Workspace-relative working directory" },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000, default: 120_000 },
      },
      ["command"],
    ),
    annotations: mutatingAnnotations(),
  },
  {
    name: "git_status",
    title: "Git status",
    description: "Show the current branch and short working-tree status.",
    inputSchema: objectSchema({}),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "git_diff",
    title: "Git diff",
    description: "Show unstaged or staged changes in the workspace.",
    inputSchema: objectSchema({
      staged: { type: "boolean", default: false },
      path: { type: "string", description: "Optional workspace-relative path filter" },
    }),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "git_log",
    title: "Git log",
    description: "Show recent commit summaries.",
    inputSchema: objectSchema({
      limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    }),
    annotations: readOnlyAnnotations(),
  },
  {
    name: "project_check",
    title: "Run project checks",
    description:
      "Run one of the project's existing npm checks: type checking, tests, or production build.",
    inputSchema: objectSchema(
      {
        check: { type: "string", enum: ["check", "test", "build"] },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000, default: 120_000 },
      },
      ["check"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

export async function callTool(name, args = {}) {
  switch (name) {
    case "workspace_info": {
      const [branch, status] = await Promise.all([
        gitWorkspaceCommand(["branch", "--show-current"]),
        gitWorkspaceCommand(["status", "--short"]),
      ]);
      let scripts = {};
      try {
        const packageJson = await readWorkspaceFile("package.json");
        scripts = JSON.parse(packageJson.content).scripts || {};
      } catch {
        scripts = {};
      }
      return {
        workspace: relativeWorkspacePath(WORKSPACE_ROOT),
        root: WORKSPACE_ROOT,
        gitBranch: branch.stdout.trim(),
        gitStatus: status.stdout.trim().split("\n").filter(Boolean),
        packageScripts: scripts,
        environmentVariableNames: Object.keys(process.env).sort(),
        note: "Environment values are intentionally withheld.",
      };
    }
    case "list_files":
      return listWorkspaceFiles({
        path: optionalString(args, "path") || ".",
        includeIgnored: optionalBoolean(args, "includeIgnored") || false,
        maxResults: optionalInteger(args, "maxResults", 1, 10_000) || 500,
      });
    case "read_file":
      return readWorkspaceFile(
        requiredString(args, "path"),
        optionalInteger(args, "maxBytes", 1, 2_000_000) || 524_288,
      );
    case "search_files":
      return searchWorkspace({
        query: requiredString(args, "query"),
        path: optionalString(args, "path") || ".",
        isRegex: optionalBoolean(args, "isRegex") || false,
        caseSensitive: optionalBoolean(args, "caseSensitive") || false,
        maxResults: optionalInteger(args, "maxResults", 1, 5_000) || 500,
      });
    case "write_file":
      return writeWorkspaceFile({
        path: requiredString(args, "path"),
        content: requiredString(args, "content", true),
        createDirectories: optionalBoolean(args, "createDirectories") || false,
        expectedSha256: optionalString(args, "expectedSha256"),
      });
    case "apply_patch":
      return applyWorkspacePatch(requiredString(args, "patch"));
    case "run_command":
      return runWorkspaceCommand({
        command: requiredString(args, "command"),
        cwd: optionalString(args, "cwd") || ".",
        timeoutMs: optionalInteger(args, "timeoutMs", 1_000, 120_000) || 120_000,
      });
    case "git_status":
      return gitWorkspaceCommand(["status", "--short", "--branch"]);
    case "git_diff": {
      const gitArgs = ["diff", "--no-ext-diff", "--binary"];
      if (optionalBoolean(args, "staged")) gitArgs.push("--cached");
      const path = optionalString(args, "path");
      if (path) gitArgs.push("--", path);
      return gitWorkspaceCommand(gitArgs);
    }
    case "git_log":
      return gitWorkspaceCommand([
        "log",
        `-${optionalInteger(args, "limit", 1, 100) || 10}`,
        "--oneline",
        "--decorate",
      ]);
    case "project_check": {
      const check = requiredString(args, "check");
      if (!["check", "test", "build"].includes(check)) {
        throw new Error("check must be one of: check, test, build");
      }
      return runWorkspaceCommand({
        command: `npm run ${check}`,
        timeoutMs: optionalInteger(args, "timeoutMs", 1_000, 120_000) || 120_000,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

export function errorResult(error) {
  return textResult(
    { error: error instanceof Error ? error.message : String(error) },
    true,
  );
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function mutatingAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  };
}

function requiredString(args, key, allowEmpty = false) {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalBoolean(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function optionalInteger(args, key, minimum, maximum) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}