import { notificationSchemaContract } from "./schema-contract";
/** Validate an already provisioned notification store. This function never repairs it. */
type SqlConnection = { query(sql: string): Promise<{ rows: any[] }> };
export async function assertNotificationSchema(connection: SqlConnection): Promise<void> {
  await connection.query("BEGIN READ ONLY");
  try {
    if ((await connection.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only !== "on") throw Error("NOTIFICATION_READ_ONLY_REQUIRED");
    const columns = (await connection.query("SELECT ns.nspname||'.'||t.relname AS relation,a.attname AS column,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace WHERE a.attnum>0 AND NOT a.attisdropped AND (ns.nspname='pgboss' OR (ns.nspname='public' AND t.relname IN ('weekly_push_runs','weekly_push_recipients','weekly_push_outbox','line_notify_logs')))")).rows;
    for (const [relation, expected] of Object.entries(notificationSchemaContract)) {
      if (Object.entries(expected).some(([column, [type, required]]) => !columns.some(row => row.relation === relation && row.column === column && row.type === type && row.required === required))) throw Error("NOTIFICATION_SCHEMA_NOT_READY");
    }
    if (!(await connection.query("SELECT to_regclass('pgboss.version') AS version")).rows[0]?.version) throw Error("NOTIFICATION_QUEUE_SCHEMA_REQUIRED");
    if (Number((await connection.query("SELECT version FROM pgboss.version")).rows[0]?.version) !== 24) throw Error("NOTIFICATION_QUEUE_VERSION");
    const objects = (await connection.query("SELECT to_regprocedure('pgboss.create_queue(text,json)') IS NOT NULL AND to_regprocedure('pgboss.delete_queue(text)') IS NOT NULL AND (SELECT relkind='p' FROM pg_class WHERE oid=to_regclass('pgboss.job')) AS ready, ARRAY(SELECT enumlabel::text FROM pg_enum WHERE enumtypid=to_regtype('pgboss.job_state') ORDER BY enumsortorder) AS states")).rows[0];
    if (objects?.ready !== true || JSON.stringify(objects.states) !== JSON.stringify(["created", "retry", "active", "completed", "cancelled", "failed"])) throw Error("NOTIFICATION_QUEUE_OBJECTS_REQUIRED");
    const indexes = (await connection.query("SELECT t.relname AS table_name, ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum WHERE k.n<=i.indnkeyatts ORDER BY k.n) AS columns FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace WHERE ns.nspname='public' AND i.indisunique AND i.indisvalid AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL")).rows;
    for (const [table, keys] of [
      ["line_notify_logs", ["coach_name", "notify_type", "schedule_date"]],
      ["weekly_push_runs", ["idempotency_key"]],
      ["weekly_push_runs", ["push_type", "week_start_date", "destination", "dry_run"]],
      ["weekly_push_recipients", ["delivery_key"]], ["weekly_push_outbox", ["run_id"]],
    ] as const) {
      if (!indexes.some(row => row.table_name === table && JSON.stringify(row.columns) === JSON.stringify(keys))) throw Error("NOTIFICATION_UNIQUE_CONSTRAINT_REQUIRED");
    }
  } finally { await connection.query("ROLLBACK"); }
}
