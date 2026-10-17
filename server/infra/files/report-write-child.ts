import { pathToFileURL } from "node:url";
import { parseReportChildRequest, ReportStorageWriteError } from "./report-write-subprocess";
import { writeDurableReportInChild } from "./reportStorage";

/** Dedicated owned-process entry; never imported as the web application main. */
async function main(): Promise<void> {
  let output = "report_storage_write_failed";
  let exitCode = 1;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new ReportStorageWriteError("report_storage_payload_too_large");
      chunks.push(Buffer.from(chunk));
    }
    const { request, contents } = parseReportChildRequest(Buffer.concat(chunks));
    output = await writeDurableReportInChild(request.runId, contents, request.ext, request.timeoutMs);
    exitCode = 0;
  } catch (error) {
    output = error instanceof ReportStorageWriteError ? error.code : "report_storage_write_failed";
  }
  // Only this owned child exits forcibly. It cannot leave SDK auth or HTTP
  // continuations alive after the parent observes process/stdio close.
  process.stdout.write(output + "\n", () => process.exit(exitCode));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stdout.write("report_storage_write_failed\n", () => process.exit(1));
  });
}
