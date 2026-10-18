import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { assertNotificationSchema } from "./infra/queue/preflight";
const target = process.env.N3_TEST_DATABASE_URL;
if (!target || process.env.N3_TEST_ALLOW_ISOLATED_PG !== "1" || !/^\/ct_ca3_[a-z0-9_]+$/.test(new URL(target).pathname) || new URL(target).hostname !== "127.0.0.1" || new URL(target).port === "5432") throw Error("Explicit isolated PostgreSQL target required");
const { Client } = createRequire(import.meta.url)("pg");
test("actual PostgreSQL preflight reads the provisioned schema and normalizes catalog name arrays", async () => {
  const client = new Client({ connectionString: target, options: "-c default_transaction_read_only=on" });
  try {
    await client.connect();
    // pg's catalog name[] parser returns a string. The production preflight
    // must request text[] so valid enum labels do not cause a false refusal.
    const raw = (await client.query("SELECT ARRAY(SELECT enumlabel FROM pg_enum WHERE enumtypid='pgboss.job_state'::regtype ORDER BY enumsortorder) AS states")).rows[0];
    assert.equal(typeof raw.states, "string");
    await assertNotificationSchema(client);
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
  } finally { await client.end(); }
});
