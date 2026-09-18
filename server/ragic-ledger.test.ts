import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
process.env.DATABASE_URL = "postgres://isolated@127.0.0.1:55438/postgres";
process.env.DATABASE_DRIVER = "pg";
process.env.NODE_ENV = "test";
const { pool } = await import("./db");
const { runDurableSync, readDurableSyncStatus } = await import("./modules/ragicSync.service");

test("persist partial results, recover after process exit and prevent duplicate coaches", async () => {
  const id = randomUUID();
  const existing = await pool.query("INSERT INTO coach_users(name,status) VALUES($1,'approved') RETURNING id", [id + " needs mapping"]);
  const items = [
    { kind: "coach" as const, sourceId: id + ":1", name: id + " new" },
    { kind: "coach" as const, sourceId: id + ":2", name: id + " needs mapping" },
  ];
  try {
    const first = await runDurableSync(async () => items);
    assert.equal(first.status, "partial_failed"); assert.equal(first.failed, 1); assert.equal(first.succeeded, 1);
    const status = await readDurableSyncStatus(); assert.equal(status.lastError?.message, "PARTIAL_SYNC_FAILED");
    const fail = await pool.query("SELECT status,error_code FROM ragic_sync_items WHERE run_id=$1 AND source_id=$2", [first.runId, items[1].sourceId]);
    assert.equal(fail.rows[0].error_code, "IDENTITY_MAPPING_REQUIRED");
    // Explicit fixture mapping models the reviewed migration, never automatic name adoption.
    await pool.query("UPDATE coach_users SET ragic_record_id=$1 WHERE id=$2", [items[1].sourceId, existing.rows[0].id]);
    const retry = await runDurableSync(null, first.runId);
    assert.equal(retry.status, "succeeded"); assert.equal(retry.succeeded, 2);
    await runDurableSync(async () => items);
    const count = await pool.query("SELECT count(*)::int n FROM coach_users WHERE ragic_record_id=ANY($1)", [items.map(i => i.sourceId)]);
    assert.equal(count.rows[0].n, 2);

    const interruptedId = randomUUID(); const item = { kind: "coach", sourceId: id + ":3", name: id + " restart" };
    const code = `import {Pool} from 'pg'; const p=new Pool({connectionString:process.env.DATABASE_URL}); const c=await p.connect(); await c.query('SELECT pg_advisory_lock(620260919)'); await c.query("INSERT INTO ragic_sync_runs(id,status) VALUES($1,'running')",[${JSON.stringify(interruptedId)}]); await c.query("INSERT INTO ragic_sync_items(run_id,kind,source_id,payload,status) VALUES($1,'coach',$2,$3,'pending')",[${JSON.stringify(interruptedId)},${JSON.stringify(item.sourceId)},${JSON.stringify(JSON.stringify(item))}]); process.exit(0);`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env, encoding: "utf-8" });
    assert.equal(child.status, 0, child.stderr);
    const afterExit = await readDurableSyncStatus();
    assert.equal(afterExit.run.status, "interrupted");
    const recovered = await runDurableSync(null, interruptedId);
    assert.equal(recovered.succeeded, 1); assert.equal(recovered.failed, 0);
    const twice = await runDurableSync(null, interruptedId); assert.equal(twice.succeeded, 1);
    const attempts = await pool.query("SELECT attempts FROM ragic_sync_items WHERE run_id=$1", [interruptedId]);
    assert.equal(attempts.rows[0].attempts, 1);
  } finally { await pool.end(); }
});
