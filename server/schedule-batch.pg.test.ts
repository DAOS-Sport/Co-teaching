import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const target = process.env.AUDIT_PG_URL;
if (!target || process.env.CT_THROWAWAY_PG !== "1") throw new Error("Throwaway PostgreSQL opt-in required");
const parsed = new URL(target);
if (parsed.hostname !== "127.0.0.1" || !/^\/ct_ca3_[a-z0-9_]+$/.test(parsed.pathname) || !parsed.port || parsed.port === "5432") throw new Error("Refusing non-disposable target");
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
process.env.ADMIN_PASSWORD = "synthetic-ca3-admin";
process.env.REPLIT_DOMAINS = "isolated.invalid";

test("CA3 actual HTTP batch/create contracts and PostgreSQL integrity", { timeout: 90_000 }, async t => {
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { eq, sql } = await import("drizzle-orm");
  const schema = await import("@shared/schema");
  const context = await import("./shared/dbContext");
  const { setAuditWriterForTest } = await import("./shared/audit");
  const { registerScheduleRoutes } = await import("./modules/schedule.routes");
  const { registerCoachPortalRoutes } = await import("./modules/coachPortal.routes");
  const express = (await import("express")).default;
  const pool = new pg.Pool({ connectionString: target, max: 8 });
  const db = drizzle(pool, { schema }); context.setBaseDbForTest(db);
  const app = express(); app.use(express.json()); registerScheduleRoutes(app); registerCoachPortalRoutes(app);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-admin-password": process.env.ADMIN_PASSWORD! }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: r.status, body: await r.json() as any };
  };
  const preview = async (text: string, mode = "update_matching") => (await post("/api/admin/schedules/import/preview", { venueId: "batch-v1", text, mode })).body;
  const commit = (text: string, token?: string) => post("/api/admin/schedules/import/commit", { venueId: "batch-v1", text, mode: "update_matching", confirmationToken: token });
  const counts = async () => (await pool.query("select (select count(*)::int from schedules) as schedules, (select count(*)::int from operation_audit) as audits")).rows[0];
  const make = async (id: string, date: string, extra = {}) => (await db.insert(schema.schedules).values({ id, date, venueId: "batch-v1", timeSlotId: "batch-slot", className: id, ...extra }).returning())[0];
  try {
    await pool.query("truncate operation_audit, schedules, venues, time_slots, coach_users restart identity cascade");
    await db.insert(schema.venues).values([1, 2].map(n => ({ id: `batch-v${n}`, name: `Synthetic Venue ${n}`, color: "blue", order: n })));
    await db.insert(schema.timeSlots).values([{ id: "batch-slot", period: "1", startTime: "08:00", endTime: "09:00", order: 1 }, { id: "batch-slot2", period: "2", startTime: "09:00", endTime: "10:00", order: 2 }]);

    await t.test("preview required; changed context invalidates confirmation without writes", async () => {
      const text = "date\tperiod\tclassName\n2099-04-06\t1\tSynthetic A";
      const before = await counts(); const p = await preview(text);
      assert.equal(p.canCommit, true); assert.equal(p.summary.create, 1);
      assert.equal((await commit(text)).status, 409); assert.deepEqual(await counts(), before);
      await make("context-change", "2099-04-06", { timeSlotId: "batch-slot2" });
      const changed = await commit(text, p.confirmationToken); assert.equal(changed.status, 409);
      assert.equal(changed.body.preview.canCommit, true);
      assert.equal((await commit(text, changed.body.preview.confirmationToken)).status, 200);
      const after = await counts(); assert.equal(after.audits - before.audits, 1);
      assert.equal((await commit(text, changed.body.preview.confirmationToken)).status, 409);
      assert.deepEqual(await counts(), after);
    });
    await t.test("omitted fields preserve values; explicit blanks list and apply clears", async () => {
      await make("preserve", "2099-04-07", { coachName: "Synthetic Coach", notes: "retain me" });
      const omitted = "date\tperiod\tclassName\n2099-04-07\t1\tpreserve";
      let p = await preview(omitted); assert.deepEqual(p.rows[0].clearedFields, []);
      assert.equal((await commit(omitted, p.confirmationToken)).status, 200);
      let row = (await db.select().from(schema.schedules).where(eq(schema.schedules.id, "preserve")))[0];
      assert.deepEqual([row.coachName, row.notes], ["Synthetic Coach", "retain me"]);
      const blanks = "date\tperiod\tclassName\tcoachName\tnotes\n2099-04-07\t1\tpreserve\t\t";
      p = await preview(blanks); assert.deepEqual(p.rows[0].clearedFields.sort(), ["coachName", "notes"]);
      assert.equal((await commit(blanks, p.confirmationToken)).status, 200);
      row = (await db.select().from(schema.schedules).where(eq(schema.schedules.id, "preserve")))[0];
      assert.deepEqual([row.coachName, row.notes], [null, null]);
    });
    await t.test("class matching agrees with independent live unique-index expression", async () => {
      // The oracle comes from the live PostgreSQL catalog, not the production helper.
      const expression = (await pool.query("select pg_get_indexdef(indexrelid,4,true) as expression from pg_index where indexrelid='uniq_schedule_class_in_cell'::regclass")).rows[0].expression;
      assert.match(expression, /regexp_replace/);
      const oracle = async (value: string) => (await pool.query(`select ${expression} as key from (select $1::text as class_name) as schedules`, [value])).rows[0].key;
      const cases = [
        [" Synthetic Ab ", "synthetic ab"], ["Synthetic Ab", "SyntheticAb"],
        ["Synthetic Ab", "SYNTHETIC AB"], ["Synthetic  Ab", "Synthetic Ab"],
        ["Synthetic\tAb", "SyntheticAb"], ["Synthetic　Ab", "SyntheticAb"],
      ];
      for (const [n, [stored, name]] of cases.entries()) {
        const date = `2099-07-${String(n+1).padStart(2,"0")}`;
        await make(`identity-${n}`, date, { className: stored });
        const p = await preview(`date\tperiod\tclassName\n${date}\t1\t${name}`);
        const matches = await oracle(name.trim()) === await oracle(stored);
        assert.equal(p.rows[0].status, matches ? "update" : "create", `identity mismatch for synthetic case ${n}`);
      }
    });
    await t.test("duplicate input blocks entire batch; audit SQL failure rolls back pending writes", async () => {
      const duplicate = "date\tperiod\tclassName\n2099-04-09\t1\tSynthetic\n2099-04-09\t1\tSYNTHETIC";
      const p = await preview(duplicate), before = await counts(); assert.equal(p.canCommit, false);
      assert.equal((await commit(duplicate, p.confirmationToken)).status, 409); assert.deepEqual(await counts(), before);
      const text = "date\tperiod\tclassName\n2099-04-09\t1\tAtomic One\n2099-04-09\t2\tAtomic Two";
      const valid = await preview(text); let observed = 0, code: string | undefined;
      setAuditWriterForTest(async () => {
        observed = Number((await context.currentDb().execute(sql`select count(*)::int as n from schedules where date='2099-04-09'`)).rows[0].n);
        try { await context.currentDb().execute(sql`insert into operation_audit(actor,action,entity,entity_id) values(null,'x','x','x')`); }
        catch (e: any) { code = e.code ?? e.cause?.code; throw e; }
      });
      try { assert.equal((await commit(text, valid.confirmationToken)).status, 500); }
      finally { setAuditWriterForTest(null); }
      assert.deepEqual([observed, code], [2, "23502"]); assert.deepEqual(await counts(), before);
    });
    await t.test("copy requires stable preview, bounds and locked target; replay writes nothing", async () => {
      await make("copy-source", "2099-05-04", { coachName: "Synthetic Coach", notes: "source notes" });
      const input = { venueId: "batch-v1", sourceStartDate: "2099-05-04", sourceEndDate: "2099-05-10", targetStartDate: "2099-05-11" };
      const p = (await post("/api/schedules/copy-week", { ...input, preview: true })).body;
      assert.equal(p.canCommit, true); assert.ok(p.rows[0].clearedFields.includes("notes"));
      const before = await counts(); assert.equal((await post("/api/schedules/copy-week", input)).status, 409); assert.deepEqual(await counts(), before);
      assert.equal((await post("/api/schedules/copy-week", { ...input, confirmationToken: p.confirmationToken })).status, 200);
      const after = await counts(); assert.equal(after.schedules - before.schedules, 1); assert.equal(after.audits - before.audits, 1);
      assert.equal((await post("/api/schedules/copy-week", { ...input, confirmationToken: p.confirmationToken })).status, 409); assert.deepEqual(await counts(), after);
      assert.equal((await post("/api/schedules/copy-week", { ...input, sourceEndDate: "2099-06-01", preview: true })).status, 400);
      assert.equal((await post("/api/schedules/copy-week", { ...input, targetStartDate: "2099-05-05", preview: true })).status, 400);
      await make("target-lock", "2099-05-18", { timeSlotId: "batch-slot2", isClassLocked: true });
      const locked = await post("/api/schedules/copy-week", { ...input, targetStartDate: "2099-05-18", preview: true });
      assert.equal(locked.body.canCommit, false); assert.equal(locked.body.rows[0].issues[0].code, "locked");
    });
    await t.test("availability context writer uses the same real transaction mutex", async () => {
      const blocker = await pool.connect(); let request: Promise<{status:number;body:any}> | undefined;
      try {
        await blocker.query("begin");
        const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid;
        await blocker.query("select pg_advisory_xact_lock(hashtext('schedule-writes'))");
        request = post("/api/coach-portal/availability", {coachName:"Synthetic Context",weekStart:"2099-08-03",slots:[{dayOfWeek:1,timeSlotOrder:1}]});
        let blocked = false; const until = Date.now()+4000;
        while (!blocked && Date.now()<until) {
          blocked = (await pool.query("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked",[pid])).rows[0].blocked;
          if (!blocked) await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.equal(blocked,true,"metadata mutation must wait on scheduling transaction");
        assert.equal((await pool.query("select count(*)::int as n from coach_availability where coach_name='Synthetic Context'")).rows[0].n,0);
      } finally {await blocker.query("rollback");blocker.release();if(request)await request.catch(()=>{});}
      assert.equal((await request!).status,200);
      assert.equal((await pool.query("select count(*)::int as n from coach_availability where coach_name='Synthetic Context'")).rows[0].n,1);
    });

    await t.test("create shares conflict confirmation and locked-date policies", async () => {
      await make("create-conflict", "2099-06-01", { venueId: "batch-v2", coachName: "Synthetic Coach Conflict" });
      const input = { date: "2099-06-01", venueId: "batch-v1", timeSlotId: "batch-slot", className: "New Class", coachName: "Synthetic Coach Conflict" };
      const before = await counts(), p = await post("/api/schedules", input);
      assert.equal(p.status, 409); assert.equal(p.body.code, "CONFIRM_REQUIRED"); assert.deepEqual(await counts(), before);
      const saved = await post("/api/schedules", { ...input, confirmationToken: p.body.confirmationToken, confirmWarnings: p.body.warnings.map((w: any) => w.code) });
      assert.equal(saved.status, 200); assert.equal(typeof saved.body.createdAt, "string"); assert.equal(saved.body.date, input.date);
      await make("create-lock", "2099-06-02", { isClassLocked: true });
      assert.equal((await post("/api/schedules", { ...input, date: "2099-06-02" })).body.code, "SCHEDULE_LOCKED");
    });
  } finally {
    setAuditWriterForTest(null); context.setBaseDbForTest(null);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end();
  }
});
