/** HTTP and MCP share the same preview/commit planner and state confirmation. */
import { previewBatchImport, commitBatchImport } from "../adapters/repositories/schedule-batch.repository";
export const previewScheduleImport = previewBatchImport;
export const commitScheduleImport = commitBatchImport;
export type ScheduleImportPreview = Awaited<ReturnType<typeof previewScheduleImport>>;
export type ScheduleImportPreviewRow = ScheduleImportPreview["rows"][number];
export type ScheduleImportIssue = ScheduleImportPreviewRow["issues"][number];
