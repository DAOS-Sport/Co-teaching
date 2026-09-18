import { Pool } from "pg";
import { readFile } from "node:fs/promises";
// Requires an explicitly reviewed mapping file. Default is a read-only check.
// Every row includes its dry-run fingerprint to reject stale mapping reviews.
type Mapping = { entity: "schedules" | "coach_availability" | "coach_venue_preferences"; id: string; target_column: "coach_user_id" | "coach_user_id_2"; source_name_fingerprint: string; coach_id: string };
const input = JSON.parse(await readFile(process.argv[2], "utf8")) as { reviewedBy: string; rows: Mapping[]; ragic?: { coach_id: string; record_id: string }[] };
if (!input.reviewedBy || !Array.isArray(input.rows)) throw new Error("REVIEWER_AND_MAPPING_REQUIRED");
const apply = process.argv.includes("--apply-reviewed-mapping");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const p = new Pool({ connectionString: process.env.DATABASE_URL }); const c = await p.connect();
try {
  await c.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  if (apply) await c.query("SELECT pg_advisory_xact_lock(620260918)");
  const targets = new Set<string>();
  for (const r of input.rows) {
    if (!["schedules", "coach_availability", "coach_venue_preferences"].includes(r.entity) ||
        !["coach_user_id", "coach_user_id_2"].includes(r.target_column) || (r.target_column === "coach_user_id_2" && r.entity !== "schedules")) throw new Error("INVALID_MAPPING_TARGET");
    const nameColumn = r.target_column === "coach_user_id_2" ? "coach_name_2" : "coach_name";
    const key = `${r.entity}:${r.id}:${r.target_column}`;
    if (targets.has(key)) throw new Error("DUPLICATE_MAPPING_TARGET");
    targets.add(key);
    const before = await c.query(`SELECT * FROM public.${r.entity} WHERE id=$1 AND md5(${nameColumn})=$2 ${apply ? "FOR UPDATE" : ""}`, [r.id, r.source_name_fingerprint]);
    if (before.rowCount !== 1 || (before.rows[0][r.target_column] && before.rows[0][r.target_column] !== r.coach_id)) throw new Error("MAPPING_STALE_OR_CONFLICTING");
    const coach = await c.query("SELECT id FROM coach_users WHERE id=$1", [r.coach_id]);
    if (coach.rowCount !== 1) throw new Error("MAPPING_COACH_NOT_FOUND");
    if (apply) {
      await c.query(`UPDATE public.${r.entity} SET ${r.target_column}=$1${r.entity === "schedules" ? ", version=version+1, updated_at=now()" : ""} WHERE id=$2`, [r.coach_id, r.id]);
      await c.query("INSERT INTO operation_audit(actor_id,actor_role,entity,entity_id,before_data,after_data) VALUES($1,'migration',$2,$3,$4,$5)", [input.reviewedBy, r.entity, r.id, JSON.stringify({ [r.target_column]: before.rows[0][r.target_column] }), JSON.stringify({ [r.target_column]: r.coach_id })]);
    }
  }
  const ragicRecords = new Set<string>(); const ragicCoaches = new Set<string>();
  for (const r of input.ragic ?? []) {
    if (!/^general-information\/23:\d+$/.test(r.record_id)) throw new Error("INVALID_RAGIC_RECORD_ID");
    if (ragicRecords.has(r.record_id) || ragicCoaches.has(r.coach_id)) throw new Error("DUPLICATE_RAGIC_MAPPING");
    ragicRecords.add(r.record_id); ragicCoaches.add(r.coach_id);
    const before = await c.query(`SELECT id,ragic_record_id FROM coach_users WHERE id=$1 ${apply ? "FOR UPDATE" : ""}`, [r.coach_id]);
    const conflicts = await c.query("SELECT id FROM coach_users WHERE ragic_record_id=$1 AND id<>$2", [r.record_id, r.coach_id]);
    if (before.rowCount !== 1 || conflicts.rowCount || (before.rows[0].ragic_record_id && before.rows[0].ragic_record_id !== r.record_id)) throw new Error("RAGIC_MAPPING_CONFLICT");
    if (apply) {
      await c.query("UPDATE coach_users SET ragic_record_id=$1,updated_at=now() WHERE id=$2", [r.record_id, r.coach_id]);
      await c.query("INSERT INTO operation_audit(actor_id,actor_role,entity,entity_id,before_data,after_data) VALUES($1,'migration','coach_ragic_identity',$2,$3,$4)", [input.reviewedBy,r.coach_id,JSON.stringify(before.rows[0]),JSON.stringify({ id:r.coach_id,ragic_record_id:r.record_id })]);
    }
  }
  await c.query(apply ? "COMMIT" : "ROLLBACK"); console.log(JSON.stringify({ applied: apply, reviewedRows: input.rows.length }));
} catch (e) { await c.query("ROLLBACK"); throw e; }
finally { c.release(); await p.end(); }
