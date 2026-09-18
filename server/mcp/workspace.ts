import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile as readFileAsync,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULTS = 500;
const MAX_COMMAND_OUTPUT_BYTES = 300 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".cache",
  ".upm",
  "coverage",
]);
const SAFE_COMMAND_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NODE_ENV",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_PREFIX",
  "PATH",
  "PORT",
  "PWD",
  "SHELL",
  "SHLVL",
  "TERM",
  "USER",
]);

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

export interface WorkspaceFile {
  path: string;
  bytes: number;
  kind: "file" | "directory" | "symlink";
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function resolveWorkspaceRoot(): string {
  const configured = process.env.CLAUDE_MCP_WORKSPACE || process.cwd();
  try {
    return realpathSync(configured);
  } catch {
    throw new Error(
      `Claude MCP workspace does not exist: ${configured}. ` +
        "Set CLAUDE_MCP_WORKSPACE or run the MCP from the project directory.",
    );
  }
}

function isInsideWorkspace(candidate: string): boolean {
  return candidate === WORKSPACE_ROOT || candidate.startsWith(`${WORKSPACE_ROOT}${sep}`);
}

function displayPath(absolutePath: string): string {
  const result = relative(WORKSPACE_ROOT, absolutePath);
  return result || ".";
}

/**
 * Resolve a user-supplied path without allowing absolute paths or traversal
 * outside the workspace. Existing symlinks are resolved before returning.
 */
export async function resolveWorkspacePath(
  inputPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error("A non-empty workspace-relative path is required.");
  }

  const candidate = resolve(WORKSPACE_ROOT, inputPath);
  if (!isInsideWorkspace(candidate)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  try {
    const resolvedPath = await realpath(candidate);
    if (!isInsideWorkspace(resolvedPath)) {
      throw new Error(`Path resolves outside the workspace: ${inputPath}`);
    }
    return resolvedPath;
  } catch (error) {
    if (!options.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const parent = await findExistingParent(dirname(candidate));
    if (!isInsideWorkspace(parent)) {
      throw new Error(`Parent path resolves outside the workspace: ${inputPath}`);
    }
    return candidate;
  }
}

export function relativeWorkspacePath(absolutePath: string): string {
  return displayPath(absolutePath);
}

export async function readWorkspaceFile(
  inputPath: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<{ path: string; bytes: number; sha256: string; content: string }> {
  const absolutePath = await resolveWorkspacePath(inputPath);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    throw new Error(`Not a regular file: ${inputPath}`);
  }
  if (fileStats.size > maxBytes) {
    throw new Error(
      `File is ${fileStats.size} bytes, over the ${maxBytes}-byte read limit: ${inputPath}`,
    );
  }

  const buffer = await readFileAsync(absolutePath);
  if (buffer.includes(0)) {
    throw new Error(`Refusing to render a binary file as text: ${inputPath}`);
  }

  return {
    path: displayPath(absolutePath),
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
    content: buffer.toString("utf8"),
  };
}

export async function listWorkspaceFiles(options: {
  path?: string;
  includeIgnored?: boolean;
  maxResults?: number;
} = {}): Promise<WorkspaceFile[]> {
  const root = await resolveWorkspacePath(options.path || ".", { allowMissing: false });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`Not a directory: ${options.path || "."}`);
  }

  const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
  const files: WorkspaceFile[] = [];
  const pending = [root];

  while (pending.length > 0 && files.length < maxResults) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (!options.includeIgnored && entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const absolutePath = resolve(current, entry.name);
      if (!isInsideWorkspace(absolutePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }

      let bytes = 0;
      try {
        bytes = (await lstat(absolutePath)).size;
      } catch {
        continue;
      }

      files.push({
        path: displayPath(absolutePath),
        bytes,
        kind: entry.isSymbolicLink() ? "symlink" : "file",
      });
      if (files.length >= maxResults) break;
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function searchWorkspace(options: {
  query: string;
  path?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  if (!options.query) throw new Error("Search query cannot be empty.");

  const files = await listWorkspaceFiles({
    path: options.path || ".",
    maxResults: 10_000,
  });
  const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
  const flags = options.caseSensitive ? "g" : "gi";
  let matcher: RegExp;
  try {
    matcher = new RegExp(options.isRegex ? options.query : escapeRegExp(options.query), flags);
  } catch (error) {
    throw new Error(`Invalid regular expression: ${(error as Error).message}`);
  }

  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (file.kind !== "file" || file.bytes > DEFAULT_MAX_FILE_BYTES) continue;

    const absolutePath = resolve(WORKSPACE_ROOT, file.path);
    let buffer: Buffer;
    try {
      buffer = await readFileAsync(absolutePath);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0;
      if (matcher.test(lines[index])) {
        matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= maxResults) {
          return { matches, truncated: true };
        }
      }
    }
  }

  return { matches, truncated: false };
}

export async function writeWorkspaceFile(options: {
  path: string;
  content: string;
  createDirectories?: boolean;
  expectedSha256?: string;
}): Promise<{ path: string; bytes: number; sha256: string }> {
  const absolutePath = await resolveWorkspacePath(options.path, { allowMissing: true });
  const parent = dirname(absolutePath);

  if (options.createDirectories) {
    await mkdir(parent, { recursive: true });
  }
  const resolvedParent = await realpath(parent);
  if (!isInsideWorkspace(resolvedParent)) {
    throw new Error(`Parent path resolves outside the workspace: ${options.path}`);
  }

  if (options.expectedSha256) {
    let current: Buffer;
    try {
      current = await readFileAsync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Expected an existing file for sha256 check: ${options.path}`);
      }
      throw error;
    }
    const currentHash = sha256(current);
    if (currentHash !== options.expectedSha256) {
      throw new Error(
        `File changed since it was read. Expected ${options.expectedSha256}, found ${currentHash}.`,
      );
    }
  }

  const buffer = Buffer.from(options.content, "utf8");
  const temporaryPath = `${absolutePath}.claude-mcp-${process.pid}-${Date.now()}`;
  await writeFileAsync(temporaryPath, buffer, { mode: 0o600 });
  await rename(temporaryPath, absolutePath).catch(async (error) => {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  });

  return {
    path: displayPath(absolutePath),
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
  };
}

export async function applyWorkspacePatch(patch: string): Promise<CommandResult> {
  if (!patch.trim()) throw new Error("Patch cannot be empty.");
  const check = await runProcess(
    "git",
    ["apply", "--check", "--whitespace=nowarn", "--"],
    WORKSPACE_ROOT,
    patch,
    30_000,
  );
  if (check.exitCode !== 0) {
    return check;
  }
  return runProcess(
    "git",
    ["apply", "--whitespace=nowarn", "--"],
    WORKSPACE_ROOT,
    patch,
    30_000,
  );
}

export async function runWorkspaceCommand(options: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CommandResult> {
  if (!options.command.trim()) throw new Error("Command cannot be empty.");
  assertSafeCommand(options.command);
  const cwdPath = await resolveWorkspacePath(options.cwd || ".", { allowMissing: false });
  const cwdStats = await stat(cwdPath);
  if (!cwdStats.isDirectory()) throw new Error(`Command cwd is not a directory: ${options.cwd}`);

  return runProcess(
    "/bin/sh",
    ["-lc", options.command],
    cwdPath,
    undefined,
    Math.min(Math.max(options.timeoutMs || 120_000, 1_000), 120_000),
  );
}

export async function gitWorkspaceCommand(
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return runProcess("git", args, WORKSPACE_ROOT, undefined, timeoutMs);
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  input: string | undefined,
  timeoutMs: number,
): Promise<CommandResult> {
  const command = [executable, ...args].map(shellQuote).join(" ");
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd,
      env: getSafeCommandEnvironment(),
      stdio: "pipe",
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const value = chunk.toString("utf8");
      if (target === "stdout") stdout = trimOutput(`${stdout}${value}`);
      else stderr = trimOutput(`${stderr}${value}`);
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({
        command,
        cwd: displayPath(cwd),
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolvePromise({
        command,
        cwd: displayPath(cwd),
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

async function findExistingParent(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function getSafeCommandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  SAFE_COMMAND_ENV_KEYS.forEach((key) => {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  });
  return environment;
}

function killProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited; fall back to the child.
    }
  }
  child.kill(signal);
}

function assertSafeCommand(command: string): void {
  const blockedPatterns: Array<[RegExp, string]> = [
    [/\brm\s+(?:-[^\s]+\s+)*\/(?:\s|$)/i, "recursive deletion from the filesystem root"],
    [/\bgit\s+reset\s+--hard\b/i, "git reset --hard"],
    [/\bgit\s+clean\b[^\n]*\s-[^\n]*f/i, "forced git clean"],
    [/\bmkfs(?:\.[a-z0-9]+)?\b/i, "filesystem formatting"],
    [/\bdd\s+if=/i, "raw disk writes"],
    [/:(){:|:&};:/, "fork bombs"],
  ];
  for (const [pattern, description] of blockedPatterns) {
    if (pattern.test(command)) {
      throw new Error(`Blocked potentially destructive command: ${description}`);
    }
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimOutput(value: string): string {
  if (value.length <= MAX_COMMAND_OUTPUT_BYTES) return value;
  return `${value.slice(0, MAX_COMMAND_OUTPUT_BYTES)}\n[output truncated]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}