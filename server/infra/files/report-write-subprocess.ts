import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024;
const TERMINATE_GRACE_MS = 150;
type ReportWriteCode = "report_storage_required" | "report_storage_config_invalid" |
  "report_storage_aborted" | "report_storage_timeout" | "report_storage_budget_exhausted" |
  "report_storage_write_failed" | "report_storage_request_invalid" |
  "report_storage_payload_too_large" | "report_storage_child_failed" | "report_storage_child_output_invalid";

export class ReportStorageWriteError extends Error {
  constructor(readonly code: ReportWriteCode) { super(code); this.name = "ReportStorageWriteError"; }
}
export interface ReportChildRequest {
  version: 1;
  runId: string;
  ext: "csv" | "xlsx";
  contentLength: number;
  timeoutMs: number;
}
export function parseReportChildRequest(payload: Buffer): { request: ReportChildRequest; contents: Buffer } {
  if (payload.length > MAX_STDIN_BYTES) throw new ReportStorageWriteError("report_storage_payload_too_large");
  const separator = payload.indexOf(10);
  if (separator < 1 || separator > 4096) throw new ReportStorageWriteError("report_storage_request_invalid");
  let request: ReportChildRequest;
  try { request = JSON.parse(payload.subarray(0, separator).toString("utf8")); }
  catch { throw new ReportStorageWriteError("report_storage_request_invalid"); }
  if (!request || request.version !== 1 || typeof request.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(request.runId) || !["csv", "xlsx"].includes(request.ext) ||
    !Number.isSafeInteger(request.contentLength) || request.contentLength < 0 ||
    request.contentLength !== payload.length - separator - 1 ||
    !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 30_000 ||
    Object.keys(request).some((key) => !["version", "runId", "ext", "contentLength", "timeoutMs"].includes(key))) {
    throw new ReportStorageWriteError("report_storage_request_invalid");
  }
  return { request, contents: payload.subarray(separator + 1) };
}

/** Owns exactly one child; close is emitted only after exit and stdio closure. */
export async function boundedReportSubprocess(
  runId: string,
  contents: string | Buffer,
  ext: "csv" | "xlsx",
  options: { signal: AbortSignal; timeoutMs: number },
  dependencies: { spawn?: typeof spawn } = {},
): Promise<string> {
  if (options.signal.aborted) throw new ReportStorageWriteError("report_storage_aborted");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 30_000) {
    throw new ReportStorageWriteError("report_storage_budget_exhausted");
  }
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(runId) || !["csv", "xlsx"].includes(ext)) {
    throw new ReportStorageWriteError("report_storage_request_invalid");
  }
  const contentSize = Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents, "utf8");
  if (contentSize >= MAX_STDIN_BYTES) throw new ReportStorageWriteError("report_storage_payload_too_large");
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const header: ReportChildRequest = { version: 1, runId, ext, contentLength: buffer.length, timeoutMs: options.timeoutMs };
  const payload = Buffer.concat([Buffer.from(JSON.stringify(header) + "\n", "utf8"), buffer]);
  if (payload.length > MAX_STDIN_BYTES) throw new ReportStorageWriteError("report_storage_payload_too_large");
  const expectedUri = `objstore://weekly-push-reports/${runId}.${ext}`;
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "./report-write-child.ts" : "./report-write-child.js", import.meta.url));
  const args = source ? ["--import", "tsx", entry] : [entry];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (dependencies.spawn ?? spawn)(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
      // Same-container SDK credentials stay in the owned child and never enter
      // argv, stdin, output, documents or another external service.
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
  } catch { throw new ReportStorageWriteError("report_storage_child_failed"); }
  return await new Promise<string>((resolve, reject) => {
    let failure: ReportWriteCode | undefined;
    let output = "";
    let outputBytes = 0;
    let stderrBytes = 0;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: ReportWriteCode) => {
      failure ??= code;
      if (closed || killTimer) return;
      child.stdin.destroy();
      // Never signal a PID read from a file, process listing or child output.
      // This ChildProcess reference is the one returned by our own spawn.
      try { child.kill("SIGTERM"); } catch { /* await close; escalate below */ }
      killTimer = setTimeout(() => {
        if (!closed) { try { child.kill("SIGKILL"); } catch { /* close remains required */ } }
      }, TERMINATE_GRACE_MS);
    };
    const onAbort = () => stop("report_storage_aborted");
    const timer = setTimeout(() => stop("report_storage_timeout"), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { stop("report_storage_child_output_invalid"); return; }
      output += chunk.toString("utf8");
    });
    // Drain diagnostics without retaining or logging provider errors/secrets.
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16_384) stop("report_storage_child_output_invalid");
    });
    child.stdin.on("error", () => stop("report_storage_child_failed"));
    child.on("error", () => stop("report_storage_child_failed"));
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) failure ??= "report_storage_aborted";
      if (failure) { reject(new ReportStorageWriteError(failure)); return; }
      if (code !== 0 || signal) {
        const staticCode = output.trim();
        const permitted: ReportWriteCode[] = ["report_storage_required", "report_storage_config_invalid", "report_storage_write_failed", "report_storage_request_invalid", "report_storage_payload_too_large"];
        reject(new ReportStorageWriteError(permitted.includes(staticCode as ReportWriteCode) ? staticCode as ReportWriteCode : "report_storage_child_failed"));
        return;
      }
      if (output !== expectedUri + "\n" || stderrBytes > 0) {
        reject(new ReportStorageWriteError("report_storage_child_output_invalid")); return;
      }
      resolve(expectedUri);
    });
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) { onAbort(); return; }
    try { child.stdin.end(payload); }
    catch { stop("report_storage_child_failed"); }
  });
}
