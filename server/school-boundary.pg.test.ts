import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const target = process.env.AUDIT_PG_URL;
if (!target || process.env.CT_THROWAWAY_PG !== "1" || new URL(target).hostname !== "127.0.0.1" || !/^\/ct_ca3_[a-z0-9_]+$/.test(new URL(target).pathname) || !new URL(target).port || new URL(target).port === "5432") throw new Error("Explicit isolated PostgreSQL target required");
process.env.DATABASE_URL = target;
test("missing school table cannot fall through to public", async () => {
  const pg = (await import("pg")).default;
  const { schoolConnectionOptions } = await import("./multi-school-db");
  const suffix=randomUUID().replaceAll("-", "");
  const school="school_ct_ca3_"+suffix, table="ct_ca3_probe_"+suffix;
  const admin = new pg.Pool({ connectionString: target });
  const old = new pg.Pool({ connectionString: target, options: `-c search_path=${school},public` });
  const candidate = new pg.Pool({ connectionString: target, options: schoolConnectionOptions(school) });
  try {
    await admin.query(`create schema ${school}; create table public.${table}(value text)`);
    await old.query(`insert into ${table} values('baseline-fallback')`);
    assert.equal((await admin.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 1);
    await assert.rejects(candidate.query(`insert into ${table} values('must-not-write')`), (e: any) => e.code === "42P01");
    assert.deepEqual((await admin.query(`select value from public.${table}`)).rows, [{ value: "baseline-fallback" }]);
    await admin.query(`create table ${school}.${table}(value text)`);
    await candidate.query(`insert into ${table} values('school-only')`);
    assert.deepEqual((await admin.query(`select value from ${school}.${table}`)).rows, [{ value: "school-only" }]);
    assert.equal((await admin.query(`select count(*)::int as n from public.${table}`)).rows[0].n, 1);
  } finally { await Promise.all([admin.end(), old.end(), candidate.end()]); }
});
