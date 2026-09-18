import { Pool } from "pg";
import { writeFile } from "node:fs/promises";

// Always read-only. Export row ids and candidate ids, never select a winner.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const c = await pool.connect();
try {
  await c.query("BEGIN READ ONLY");
  await c.query("SET LOCAL statement_timeout='15000'");
  const result = await c.query(`WITH refs AS (
    SELECT 'coach_availability' AS entity,id,'coach_user_id' AS target_column,coach_name AS name FROM coach_availability
    UNION ALL SELECT 'coach_venue_preferences',id,'coach_user_id',coach_name FROM coach_venue_preferences
    UNION ALL SELECT 'schedules',id,'coach_user_id',coach_name FROM schedules WHERE coalesce(coach_name,'')<>''
    UNION ALL SELECT 'schedules',id,'coach_user_id_2',coach_name_2 FROM schedules WHERE coalesce(coach_name_2,'')<>''
  ) SELECT entity,id,target_column,md5(name) AS source_name_fingerprint,
    ARRAY(SELECT c.id FROM coach_users c WHERE c.name=r.name ORDER BY c.id) AS candidate_ids
    FROM refs r ORDER BY entity,id,target_column`);
  await c.query("ROLLBACK");
  const summary = { total: result.rows.length, unmatched: result.rows.filter(r => r.candidate_ids.length === 0).length,
    ambiguous: result.rows.filter(r => r.candidate_ids.length > 1).length,
    singleCandidateUnapproved: result.rows.filter(r => r.candidate_ids.length === 1).length };
  await writeFile(process.argv[2] || "identity-dry-run.json", JSON.stringify({ status: "REQUIRES_HUMAN_MAPPING", summary, rows: result.rows }, null, 2));
  console.log(JSON.stringify(summary));
} finally { c.release(); await pool.end(); }
