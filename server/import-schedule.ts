/** Retired fixture importer: it ignored school scope and deleted shared schedules.
 * Historical source remains recoverable from Git; use the scoped preview API.
 */
export async function importScheduleData(): Promise<never> {
  throw Object.assign(new Error("Legacy fixture import is retired; use schedule import preview/commit"), { code: "LEGACY_IMPORT_RETIRED" });
}
