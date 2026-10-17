/**
 * Durable report storage for the weekly push pipeline.
 *
 * Originally (Task #23) reports were written to `/tmp/weekly-push-reports/`,
 * but `/tmp` is wiped on every Replit redeploy / container restart so admins
 * clicking the download link on an older run got a 404.
 *
 * Task #27 promotes storage to Replit Object Storage (a GCS bucket exposed
 * via the sidecar) so reports stay available for the lifetime of the run row.
 *
 * Storage layout
 * --------------
 *   ${PRIVATE_OBJECT_DIR}/weekly-push-reports/<runId>.csv
 *
 * The path persisted on `weekly_push_runs.report_path` is a stable URI of
 * the form `objstore://weekly-push-reports/<runId>.csv` — relative to
 * `PRIVATE_OBJECT_DIR` so a future bucket move does not invalidate old rows.
 *
 * Backwards compatibility
 * -----------------------
 * Existing rows still point at `/tmp/weekly-push-reports/<runId>.csv`. The
 * read/exists helpers detect `/tmp/...` paths and fall back to the local
 * filesystem so old runs (whose files happen to still be on this container)
 * keep working during the transition. Once the next deploy wipes `/tmp`
 * those legacy reports are gone for good — that is unavoidable, the durable
 * copy only exists for runs created from this task forward.
 *
 * Retention policy
 * ----------------
 * Reports are retained for **90 days**. Cleanup is currently manual — a
 * scheduled job (or one-off script) should list all `weekly_push_runs` whose
 * `created_at < now() - interval '90 days'`, delete the underlying object,
 * and null out `report_path`. Implementing the cleanup job is tracked
 * separately; the storage layer itself imposes no expiry, so reports remain
 * readable indefinitely until that job runs.
 *
 * Local-dev fallback
 * ------------------
 * If `PRIVATE_OBJECT_DIR` is unset (e.g. some local dev shells) we fall back
 * to writing to `/tmp/weekly-push-reports/` exactly like the old behaviour.
 */
import { promises as fs } from "fs";
import path from "path";
import type { Response } from "express";
import { objectStorageClient } from "../../replit_integrations/object_storage/objectStorage";
import { assertOperationActive, currentOperation, remainingOperationMs } from "../../shared/http/operationScope";
import { boundedReportSubprocess, ReportStorageWriteError } from "./report-write-subprocess";

const LEGACY_REPORT_DIR = "/tmp/weekly-push-reports";
const OBJECT_PREFIX = "weekly-push-reports";
const URI_SCHEME = "objstore://";
const SCOPED_WRITE_RESERVE_MS = 1500;

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, "");
}

function getPrivateObjectDir(): string | null {
  const dir = process.env.PRIVATE_OBJECT_DIR?.trim();
  return dir && dir.length > 0 ? dir : null;
}

/**
 * Parses an object storage URI of the form `objstore://<key>` (relative to
 * PRIVATE_OBJECT_DIR) into the absolute `/<bucket>/<object>` path used by
 * the GCS client.
 */
function resolveObjectPath(uri: string): { bucket: string; object: string } {
  if (!uri.startsWith(URI_SCHEME)) {
    throw new Error(`[reportStorage] not an object storage URI: ${uri}`);
  }
  const dir = getPrivateObjectDir();
  if (!dir) {
    throw new Error(
      "[reportStorage] PRIVATE_OBJECT_DIR is not set; cannot resolve " +
        `object storage URI ${uri}`,
    );
  }
  const relativeKey = uri.slice(URI_SCHEME.length);
  const fullPath = `${dir.replace(/\/$/, "")}/${relativeKey}`;
  // fullPath looks like `/<bucket>/<object>`.
  const normalized = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  const parts = normalized.split("/");
  if (parts.length < 3) {
    throw new Error(
      `[reportStorage] resolved path is too short to contain bucket+object: ${normalized}`,
    );
  }
  const bucket = parts[1];
  const object = parts.slice(2).join("/");
  if (!bucket || !object) {
    throw new Error(`[reportStorage] could not split bucket/object from ${normalized}`);
  }
  return { bucket, object };
}

function isObjectStorageUri(p: string): boolean {
  return p.startsWith(URI_SCHEME);
}

function isLegacyTmpPath(p: string): boolean {
  return p.startsWith(LEGACY_REPORT_DIR);
}

/**
 * Returns the canonical local-fs path for a legacy /tmp report. Kept for
 * the local-dev fallback when PRIVATE_OBJECT_DIR is unset.
 */
export function reportPathFor(runId: string, ext: "csv" | "xlsx" = "csv"): string {
  return path.join(LEGACY_REPORT_DIR, `${safeRunId(runId)}.${ext}`);
}

async function ensureLegacyDir(): Promise<void> {
  await fs.mkdir(LEGACY_REPORT_DIR, { recursive: true });
}

async function writeToObjectStorage(
  runId: string,
  contents: string | Buffer,
  ext: "csv" | "xlsx",
  timeoutMs?: number,
): Promise<string> {
  const safe = safeRunId(runId);
  const relativeKey = `${OBJECT_PREFIX}/${safe}.${ext}`;
  const uri = `${URI_SCHEME}${relativeKey}`;
  const { bucket, object } = resolveObjectPath(uri);
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const contentType = ext === "csv" ? "text/csv; charset=utf-8" : "application/octet-stream";
  await objectStorageClient
    .bucket(bucket)
    .file(object)
    .save(buf, {
      contentType,
      resumable: false,
      metadata: { contentType },
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    });
  return uri;
}

function requireDurableDirectory(): void {
  const directory = getPrivateObjectDir();
  if (!directory) throw new ReportStorageWriteError("report_storage_required");
  if (!/^\/?[^/]+(?:\/[^/]+)*\/?$/.test(directory) || directory.includes("\\") ||
    directory.split("/").some((part) => part === "." || part === "..")) {
    throw new ReportStorageWriteError("report_storage_config_invalid");
  }
}

/** Dedicated child-only durable call; no fallback or provider-error logging. */
export async function writeDurableReportInChild(
  runId: string, contents: Buffer, ext: "csv" | "xlsx", timeoutMs: number,
): Promise<string> {
  requireDurableDirectory();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000 ||
    !/^[a-zA-Z0-9_-]{1,256}$/.test(runId) || !["csv", "xlsx"].includes(ext)) {
    throw new ReportStorageWriteError("report_storage_request_invalid");
  }
  try { return await writeToObjectStorage(runId, contents, ext, timeoutMs); }
  catch { throw new ReportStorageWriteError("report_storage_write_failed"); }
}

/**
 * Persists a generated report and returns the path/URI to store on
 * `weekly_push_runs.report_path`. Request-scoped calls require durable storage
 * and await an owned SDK child's close boundary. Outside a request scope,
 * preserve the existing Object Storage save and local fallback behavior.
 */
export async function writeReport(
  runId: string,
  contents: string | Buffer,
  ext: "csv" | "xlsx" = "csv",
): Promise<string> {
  const operation = currentOperation();
  if (operation) {
    assertOperationActive(SCOPED_WRITE_RESERVE_MS);
    requireDurableDirectory();
    const timeoutMs = Math.floor(remainingOperationMs(30_000, SCOPED_WRITE_RESERVE_MS));
    const uri = await boundedReportSubprocess(
      runId, contents, ext,
      { signal: operation.signal, timeoutMs },
    );
    assertOperationActive();
    return uri;
  }
  if (getPrivateObjectDir()) {
    try {
      return await writeToObjectStorage(runId, contents, ext);
    } catch (err) {
      console.error(
        "[reportStorage] object storage write failed, falling back to /tmp",
        err,
      );
    }
  }
  await ensureLegacyDir();
  const filePath = reportPathFor(runId, ext);
  await fs.writeFile(filePath, contents);
  return filePath;
}

/**
 * Returns true if the report referenced by `pathOrUri` is still readable.
 */
export async function reportExists(pathOrUri: string): Promise<boolean> {
  if (isObjectStorageUri(pathOrUri)) {
    try {
      const { bucket, object } = resolveObjectPath(pathOrUri);
      const [exists] = await objectStorageClient.bucket(bucket).file(object).exists();
      return exists;
    } catch (err) {
      console.error("[reportStorage] reportExists object storage error", err);
      return false;
    }
  }
  if (isLegacyTmpPath(pathOrUri)) {
    try {
      await fs.access(pathOrUri);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Reads the full report contents into memory. Use `streamReport` for the
 * download endpoint to avoid buffering large CSVs.
 */
export async function readReport(pathOrUri: string): Promise<Buffer> {
  if (isObjectStorageUri(pathOrUri)) {
    const { bucket, object } = resolveObjectPath(pathOrUri);
    const [buf] = await objectStorageClient.bucket(bucket).file(object).download();
    return buf;
  }
  if (!isLegacyTmpPath(pathOrUri)) {
    throw new Error("[reportStorage] refusing to read path outside report stores");
  }
  // Sanity check — never let a caller hand us a path outside the legacy dir.
  const resolved = path.resolve(pathOrUri);
  if (!resolved.startsWith(path.resolve(LEGACY_REPORT_DIR))) {
    throw new Error("[reportStorage] refusing to read path outside report dir");
  }
  return fs.readFile(resolved);
}

/**
 * Deletes a report from Object Storage (or legacy /tmp). Safe to call on
 * paths that no longer exist — errors are caught and logged as warnings.
 * Returns true if the file was found and deleted, false if it was already
 * gone or the path is unrecognised.
 */
export async function deleteReport(pathOrUri: string): Promise<boolean> {
  if (isObjectStorageUri(pathOrUri)) {
    try {
      const { bucket, object } = resolveObjectPath(pathOrUri);
      await objectStorageClient.bucket(bucket).file(object).delete({ ignoreNotFound: true });
      return true;
    } catch (err) {
      console.warn("[reportStorage] deleteReport object storage error:", err);
      return false;
    }
  }
  if (isLegacyTmpPath(pathOrUri)) {
    try {
      await fs.unlink(pathOrUri);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      console.warn("[reportStorage] deleteReport legacy fs error:", err);
      return false;
    }
  }
  console.warn("[reportStorage] deleteReport: unrecognised path/URI", pathOrUri);
  return false;
}

/**
 * Streams the report directly to the given Express response. Sets only the
 * Content-Type — callers are expected to set Content-Disposition / status.
 */
export async function streamReport(
  pathOrUri: string,
  res: Response,
  ext: "csv" | "xlsx" = "csv",
): Promise<void> {
  const contentType =
    ext === "csv" ? "text/csv; charset=utf-8" : "application/octet-stream";
  if (!res.getHeader("Content-Type")) {
    res.setHeader("Content-Type", contentType);
  }

  if (isObjectStorageUri(pathOrUri)) {
    const { bucket, object } = resolveObjectPath(pathOrUri);
    await new Promise<void>((resolve, reject) => {
      const stream = objectStorageClient.bucket(bucket).file(object).createReadStream();
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
    return;
  }

  if (!isLegacyTmpPath(pathOrUri)) {
    throw new Error("[reportStorage] refusing to stream path outside report stores");
  }
  const resolved = path.resolve(pathOrUri);
  if (!resolved.startsWith(path.resolve(LEGACY_REPORT_DIR))) {
    throw new Error("[reportStorage] refusing to stream path outside report dir");
  }
  const buf = await fs.readFile(resolved);
  res.end(buf);
}
