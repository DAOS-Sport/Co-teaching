/** Boot never grants permission to modify application data or start jobs. */
export const startupPolicy = Object.freeze({
  databaseMaintenance: false,
  backgroundJobs: false,
  sessionPruning: false,
} as const);

/** Explicit operation context; this is not authentication or user authorization. */
export type MaintenanceInvocation = Readonly<{ mode: "maintenance" }>;

export function assertMaintenanceInvocation(value: unknown): asserts value is MaintenanceInvocation {
  if (!value || typeof value !== "object" || (value as { mode?: unknown }).mode !== "maintenance") {
    throw Object.assign(
      new Error("This operation requires an explicit maintenance invocation and cannot run during app boot."),
      { code: "MAINTENANCE_REQUIRED" },
    );
  }
}
