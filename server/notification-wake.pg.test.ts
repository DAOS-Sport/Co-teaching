import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

// Run alone with --test-concurrency=1. Runner supplies synthetic configuration;
// this test never reads an environment file or substitutes DATABASE_URL.
test("EW2 actual wake: isolated native PostgreSQL, bounded recovery and immutable identities", { timeout: 300_000 }, async t => {
  assert.ok(process.env.N3_TEST_ALLOW_ISOLATED_PG === "1", "isolated_pg_opt_in_required");
  const url = process.env.N3_TEST_DATABASE_URL;
  assert.ok(url, "isolated_pg_url_required");
  const target = new URL(url);
  assert.ok(target.protocol === "postgres:" || target.protocol === "postgresql:", "isolated_pg_protocol_required");
  assert.ok(target.hostname === "127.0.0.1", "isolated_pg_localhost_required");
  assert.ok(target.port && Number(target.port) > 0 && target.port !== "5432", "isolated_pg_owned_port_required");
  assert.ok(/^\/ct_ca3_[a-zA-Z0-9_]+$/.test(target.pathname), "isolated_pg_database_required");
  for (const [name, value] of target.searchParams) assert.ok(name === "sslmode" && value === "disable", "isolated_pg_url_override_rejected");
  assert.ok(!target.hash, "isolated_pg_url_fragment_rejected");
  assert.ok(process.env.DATABASE_URL === url, "isolated_pg_database_url_exact_match_required");
  for (const [name, expected] of Object.entries({ NODE_ENV: "production", ADMIN_PASSWORD: "synthetic-ew2-admin",
    TEACHER_TOKEN_SECRET: "synthetic-ew2-teacher-secret", LINE_CHANNEL_ACCESS_TOKEN: "synthetic-ew2-line-token",
    ENABLE_WEEKLY_PUSH_QUEUE: "1" })) assert.ok(process.env[name] === expected, `synthetic_configuration_required:${name}`);

  const originalFetch = globalThis.fetch;
  const originalMode = process.env.NOTIFICATION_WAKE_MODE;
  const originalEnabled = process.env.NOTIFICATION_WAKE_ENABLED;
  const originalNotBefore = process.env.NOTIFICATION_WAKE_NOT_BEFORE;
  const accepted = new Map<string, string>();
  let lineCalls = 0, forbiddenHttp = 0, allowLine = false;
  globalThis.fetch = async (input, init) => {
    if (!allowLine || String(input) !== "https://api.line.me/v2/bot/message/push") { forbiddenHttp++; throw Error("fixture_external_transport_forbidden"); }
    const headers = new Headers(init?.headers);
    assert.ok(headers.get("authorization") === "Bearer synthetic-ew2-line-token", "fixture_synthetic_line_token_required");
    const key = headers.get("x-line-retry-key");
    assert.ok(key && /^[0-9a-f-]{36}$/i.test(key), "fixture_saved_retry_key_required");
    assert.ok(typeof init?.body === "string", "fixture_saved_line_body_required");
    const body = JSON.parse(init.body);
    assert.ok(typeof body.to === "string" && body.to.startsWith("synthetic-ew2-dest-"), "fixture_destination_required");
    assert.ok(body.messages?.[0]?.text?.startsWith("synthetic-ew2-message-"), "fixture_message_required");
    lineCalls++;
    if (accepted.has(key)) {
      assert.equal(accepted.get(key), init.body, "saved retry key must retain the original request");
      return new Response("", { status: 409, headers: { "x-line-accepted-request-id": `synthetic-accepted-${key}` } });
    }
    accepted.set(key, init.body);
    return new Response("", { status: 200, headers: { "x-line-request-id": `synthetic-accepted-${key}` } });
  };
  process.env.NOTIFICATION_WAKE_ENABLED = "true";
  process.env.NOTIFICATION_WAKE_MODE = "canary";
  // Prevent this fixture from planning today's non-fixture Ragic/daily/weekly work.
  process.env.NOTIFICATION_WAKE_NOT_BEFORE = new Date(Date.now() + 86_400_000).toISOString();

  const require = createRequire(import.meta.url);
  const { Client } = require("pg");
  const admin = new Client({ connectionString: url, application_name: "ct-ew2-pg-acceptance", connectionTimeoutMillis: 3000,
    options: "-c statement_timeout=15000 -c lock_timeout=1000" });
  const ownedJobs = new Set<string>(), ownedRuns = new Set<string>(), ownedVenues = new Set<string>();
  const ownedRoles = new Set<string>();
  const triggers = new Set<string>();
  const tag = `ew2pg_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
  let connected = false;
  let appPool: { end(): Promise<void> } | undefined;
  let initialHeartbeats = new Set<string>();
  try {
    await admin.connect(); connected = true;
    assert.equal((await admin.query("SELECT current_database() db")).rows[0].db, target.pathname.slice(1));
    assert.equal((await admin.query("SELECT count(*)::int n FROM pgboss.schedule")).rows[0].n, 0, "fixture requires no old cron registration");
    assert.equal((await admin.query("SELECT count(*)::int n FROM pgboss.job WHERE state < 'completed'")).rows[0].n, 0, "fixture refuses to process another test's active work");
    assert.equal((await admin.query("SELECT count(*)::int n FROM weekly_push_runs WHERE completed_at IS NULL AND status IN ('queued','preparing','sending','unknown','failed')")).rows[0].n, 0, "fixture requires no preexisting unfinished run");
    initialHeartbeats = new Set((await admin.query("SELECT id FROM pgboss.job WHERE data->>'kind'='wake-heartbeat'")).rows.map((row: any) => row.id));
    const { executeNotificationWake, wakeJobId } = await import("./modules/notificationWake/wake-runtime");
    const { runInOperationScope } = await import("./shared/http/operationScope");
    const { boundedNativePg } = await import("./infra/queue/bounded-native-pg");
    const { createRagicCheckpoint } = await import("./modules/notificationWake/ragic-checkpoint");
    const { default: PgBoss } = await import("pg-boss");
    const { queues } = await import("./infra/queue/queues");
    appPool = (await import("./db")).pool;
    const producer = new PgBoss({ db: { executeSql: (text, values) => admin.query(text, values) }, migrate: false, supervise: false, schedule: false });
    const wake = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const trackHeartbeat = () => {
        const id = wakeJobId(`wake-heartbeat:v1:${Math.floor(Date.now() / 300_000)}`);
        if (!initialHeartbeats.has(id)) ownedJobs.add(id);
      };
      trackHeartbeat();
      try { return await runInOperationScope({ signal: controller.signal, deadlineMs: Date.now() + 20_000, abort: () => controller.abort() }, executeNotificationWake); }
      finally { clearTimeout(timer); trackHeartbeat(); }
    };
    const publicOracle = async () => {
      const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const result = [];
      for (const { tablename } of tables) result.push({ table: tablename, ...(await admin.query(
        `SELECT count(*)::int n,md5(COALESCE(string_agg(to_jsonb(x)::text,'|' ORDER BY to_jsonb(x)::text),'')) digest FROM public.${quote(tablename)} x`,
      )).rows[0] });
      return result;
    };
    const doneCheckpoint = () => ({ ...createRagicCheckpoint("2040-01-02"), phase: "complete" as const, status: "success" as const,
      snapshots: { departments: [], coaches: [], employees: [] } });
    const sendJob = async (name: string, data: object, id = randomUUID()) => {
      assert.equal(await producer.send(name, data, { id, retryLimit: 20, retryDelay: 0, expireInSeconds: 1 }), id);
      ownedJobs.add(id);
      return id;
    };
    const job = async (id: string) => (await admin.query("SELECT * FROM pgboss.job WHERE id=$1", [id])).rows[0];
    const waitOwnRetryDue = async (id: string, maxWaitMs = 75_000) => {
      assert.ok(ownedJobs.has(id), "fixture_may_wait_only_for_owned_job");
      const started = Date.now();
      const readDue = async () => (await admin.query("SELECT state,started_on,start_after,clock_timestamp() server_now FROM pgboss.job WHERE id=$1", [id])).rows[0];
      const initial = await readDue(); assert.ok(initial);
      let current = initial;
      while (current.state === "retry" && current.start_after.getTime() > current.server_now.getTime()) {
        const budget = maxWaitMs - (Date.now() - started);
        assert.ok(budget > 0, "fixture_real_retry_wait_budget_exhausted");
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, budget, current.start_after.getTime() - current.server_now.getTime())));
        current = await readDue(); assert.ok(current);
      }
      return { waitMs: Date.now() - started, startAfter: initial.start_after, startedOnBeforeWait: initial.started_on };
    };
    const installTrigger = async (suffix: string, columns: string, condition: string, action: string) => {
      const name = `${tag}_${suffix}`;
      triggers.add(name);
      await admin.query(`CREATE FUNCTION pgboss.${quote(name)}() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN
        IF ${condition} THEN ${action}; END IF; RETURN NEW; END $fixture$`);
      await admin.query(`CREATE TRIGGER ${quote(name)} BEFORE UPDATE OF ${columns} ON pgboss.job FOR EACH ROW EXECUTE FUNCTION pgboss.${quote(name)}()`);
      return name;
    };
    const dropTrigger = async (name: string) => {
      await admin.query(`DROP TRIGGER IF EXISTS ${quote(name)} ON pgboss.job`);
      await admin.query(`DROP FUNCTION IF EXISTS pgboss.${quote(name)}()`);
      triggers.delete(name);
    };
    const removeJobs = async (ids: string[]) => {
      await admin.query("DELETE FROM pgboss.job WHERE id=ANY($1::uuid[])", [ids]);
      await admin.query("DELETE FROM pgboss.archive WHERE id=ANY($1::uuid[])", [ids]);
    };

    await t.test("canary creates exactly the existing eight queues and heartbeat with zero public DML/HTTP", async () => {
      const before = await publicOracle();
      const result = await wake();
      assert.deepEqual(result, { version: 1, status: "drained", remainingWork: false, processed: 0, failed: 0 });
      assert.deepEqual((await admin.query("SELECT name FROM pgboss.queue ORDER BY name")).rows.map((row: any) => row.name), Object.values(queues).sort());
      assert.deepEqual(await publicOracle(), before);
      assert.equal(lineCalls, 0); assert.equal(forbiddenHttp, 0);
    });
    await t.test("duplicate wake in the same five-minute slot retains one heartbeat ID and created timestamp", async () => {
      const left = 300_000 - Date.now() % 300_000;
      if (left < 5000) await new Promise(resolve => setTimeout(resolve, left + 25));
      const bucket = Math.floor(Date.now() / 300_000), id = wakeJobId(`wake-heartbeat:v1:${bucket}`);
      await wake();
      const first = await job(id); assert.ok(first);
      await wake();
      assert.equal(Math.floor(Date.now() / 300_000), bucket, "fixture must remain within the selected real clock slot");
      const second = await job(id);
      assert.equal(second.id, first.id); assert.deepEqual(second.created_on, first.created_on); assert.deepEqual(second.data, first.data);
      assert.equal((await admin.query("SELECT count(*)::int n FROM pgboss.job WHERE id=$1", [id])).rows[0].n, 1);
    });
    await t.test("a different native session holding advisory lock returns busy with zero work", async () => {
      const lock = new Client({ connectionString: url });
      await lock.connect();
      try {
        await lock.query("SELECT pg_advisory_lock($1)", [1_927_741_305]);
        assert.deepEqual(await wake(), { version: 1, status: "busy", remainingWork: true, processed: 0, failed: 0 });
      } finally { await lock.query("SELECT pg_advisory_unlock($1)", [1_927_741_305]); await lock.end(); }
    });
    await t.test("100ms abort terminates real pg_sleep(10), dispose settles and its backend disappears", async () => {
      const controller = new AbortController();
      let backend: number | undefined;
      const started = Date.now();
      await runInOperationScope({ signal: controller.signal, deadlineMs: Date.now() + 20_000, abort: () => controller.abort() }, async () => {
        const owned = boundedNativePg(url);
        await owned.client.connect();
        backend = (await owned.client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        const timer = setTimeout(() => controller.abort(), 100);
        try { await assert.rejects(owned.client.query("SELECT pg_sleep(10)")); }
        finally { clearTimeout(timer); await owned.dispose(); }
      });
      assert.ok(Date.now() - started < 4000, "native abort must settle before query_timeout fallback");
      const remaining = (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1", [backend])).rows[0].n;
      assert.equal(remaining, 0, "successful_dispose_must_already_prove_backend_gone");
      t.diagnostic(JSON.stringify({ fixture: tag, case: "abort_positive_immediate_oracle", backend, backendRowsImmediatelyAfterDispose: remaining, elapsedMs: Date.now() - started }));
    });
    await t.test("CONNECTION LIMIT1 denies the cancel buddy, so disposal rejects before real server-timeout recovery", async () => {
      const role = `ct_ew2_neg4_${randomUUID().replaceAll("-", "")}`;
      // This is an ephemeral synthetic fixture credential; never emit the URL,
      // password or full connection config into assertion diagnostics.
      const rolePassword = randomUUID();
      await admin.query(`CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 PASSWORD '${rolePassword}'`);
      ownedRoles.add(role);
      await admin.query(`GRANT CONNECT ON DATABASE ${quote(target.pathname.slice(1))} TO ${quote(role)}`);
      const attributes = (await admin.query("SELECT rolsuper,rolconnlimit FROM pg_roles WHERE rolname=$1", [role])).rows[0];
      assert.equal(attributes.rolsuper, false); assert.equal(attributes.rolconnlimit, 1);
      const roleUrl = new URL(url);
      roleUrl.username = role; roleUrl.password = rolePassword;
      roleUrl.searchParams.set("application_name", "fixture-untrusted-uri-application");
      roleUrl.searchParams.set("options", "-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0");
      roleUrl.searchParams.set("query_timeout", "0");
      roleUrl.searchParams.set("connectionTimeoutMillis", "0");
      const controller = new AbortController();
      let owned: ReturnType<typeof boundedNativePg> | undefined;
      let backend: number | undefined, applicationName: string | undefined;
      let disposeCode = "", rowsAtDispose: number | undefined, serverTimeoutWaitMs = 0;
      const fixtureStarted = Date.now();
      let queryStarted: number | undefined;
      const backendRows = async () => (await admin.query(`SELECT count(*)::int n FROM pg_stat_activity
        WHERE pid=$1 AND usename=$2 AND application_name=$3 AND datname=$4`,
      [backend, role, applicationName, target.pathname.slice(1)])).rows[0].n as number;
      try {
        await runInOperationScope({ signal: controller.signal, deadlineMs: Date.now() + 20_000, abort: () => controller.abort() }, async () => {
          owned = boundedNativePg(roleUrl.href);
          await owned.client.connect();
          const configuration = (await owned.client.query(`SELECT pg_backend_pid() pid,current_user role_name,
            current_database() db,current_setting('application_name') app,
            current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,
            current_setting('idle_in_transaction_session_timeout') idle_timeout`)).rows[0];
          backend = configuration.pid; applicationName = configuration.app;
          assert.ok(configuration.role_name === role && configuration.db === target.pathname.slice(1), "same_isolated_database_and_synthetic_role_required");
          assert.ok(typeof applicationName === "string" && applicationName.startsWith("ct-external-wake-v1:") && applicationName !== "fixture-untrusted-uri-application", "uri_must_not_override_owned_application_identity");
          assert.equal(configuration.statement_timeout, "3s");
          assert.equal(configuration.lock_timeout, "500ms");
          assert.equal(configuration.idle_timeout, "10s");
          const deniedBuddy = new Client({ connectionString: roleUrl.href, connectionTimeoutMillis: 1000 });
          deniedBuddy.on("error", () => {});
          try { await assert.rejects(deniedBuddy.connect(), (error: any) => error?.code === "53300"); }
          finally { await deniedBuddy.end().catch(() => {}); }
          const timer = setTimeout(() => controller.abort(), 100);
          try {
            queryStarted = Date.now();
            await assert.rejects(owned.client.query("SELECT pg_sleep(10)"));
            await assert.rejects(owned.dispose(), (error: unknown) => {
              disposeCode = error instanceof Error ? error.message : "non_error";
              return disposeCode === "wake_backend_quiescence_unverified";
            });
            rowsAtDispose = await backendRows();
          } finally { clearTimeout(timer); }
        });
        // The expected rejection is retained first. Only then observe the real
        // server timeout; this must never turn rejected disposal into success.
        const waiting = Date.now();
        let remaining = await backendRows();
        while (remaining && Date.now() - waiting < 6000) {
          await new Promise(resolve => setTimeout(resolve, 25));
          remaining = await backendRows();
        }
        serverTimeoutWaitMs = Date.now() - waiting;
        assert.equal(remaining, 0, "server_statement_timeout_must_eventually_release_owned_backend");
        assert.equal(disposeCode, "wake_backend_quiescence_unverified");
        t.diagnostic(JSON.stringify({ fixture: tag, case: "cancel_buddy_connection_limit_negative", role, backend,
          buddySqlstate: "53300", disposeCode, backendRowsAtRejectedDispose: rowsAtDispose, serverTimeoutWaitMs,
          elapsedMs: Date.now() - fixtureStarted, queryElapsedMs: queryStarted === undefined ? null : Date.now() - queryStarted,
          backendRowsAfterRealTimeout: remaining,
          serverStatementTimeoutMs: 3000, uriSafetySettingsPreserved: true }));
      } finally {
        await owned?.dispose().catch(() => {});
        if (backend !== undefined) {
          const cleanupStarted = Date.now();
          let remaining = await backendRows();
          while (remaining && Date.now() - cleanupStarted < 6000) {
            await new Promise(resolve => setTimeout(resolve, 25));
            remaining = await backendRows();
          }
          assert.equal(remaining, 0, "fixture_role_cleanup_requires_its_backend_gone");
        }
        await admin.query(`REVOKE CONNECT ON DATABASE ${quote(target.pathname.slice(1))} FROM ${quote(role)}`);
        await admin.query(`DROP ROLE ${quote(role)}`);
        ownedRoles.delete(role);
        assert.equal((await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname=$1", [role])).rows[0].n, 0);
      }
    });
    process.env.NOTIFICATION_WAKE_MODE = "active";
    await t.test("active wake explicitly expires and recovers the same saved job ID/checkpoint", async () => {
      const body = { version: 1, kind: "ragic-sync", checkpoint: doneCheckpoint() };
      const id = await sendJob(queues.notificationReconcile, body);
      try {
        await admin.query("UPDATE pgboss.job SET state='active',started_on=now()-interval '60 seconds',expire_in=interval '1 second' WHERE id=$1", [id]);
        const result = await wake(); assert.equal(result.failed, 0);
        const saved = await job(id);
        assert.equal(saved.id, id); assert.equal(saved.state, "completed");
        assert.deepEqual(saved.data.checkpoint, body.checkpoint); assert.equal(saved.data.kind, body.kind);
        assert.equal((await admin.query("SELECT count(*)::int n FROM pgboss.job WHERE id=$1", [id])).rows[0].n, 1);
      } finally { await removeJobs([id]); }
    });
    await t.test("real fetch SQL error is not swallowed into a drained result", async () => {
      const id = await sendJob(queues.notificationReconcile, { version: 1, kind: "ragic-sync", checkpoint: doneCheckpoint() });
      const trigger = await installTrigger("fetch", "state", `OLD.id='${id}'::uuid AND OLD.state='created' AND NEW.state='active'`, "RAISE EXCEPTION 'ct_ew2_fixture_fetch_blocked'");
      try {
        await assert.rejects(wake(), /^Error: wake_fetch_sql_failed$/);
        assert.equal((await job(id)).state, "created");
      } finally { await dropTrigger(trigger); await removeJobs([id]); }
    });
    await t.test("blocked completion acknowledgement returns failed/remaining and preserves the job", async () => {
      const id = await sendJob(queues.notificationReconcile, { version: 1, kind: "ragic-sync", checkpoint: doneCheckpoint() });
      const trigger = await installTrigger("ack", "state", `OLD.id='${id}'::uuid AND OLD.state='active' AND NEW.state='completed'`, "RAISE EXCEPTION 'ct_ew2_fixture_ack_blocked'");
      try {
        const result = await wake();
        assert.ok(result.failed > 0); assert.equal(result.remainingWork, true); assert.equal(result.status, "remaining");
        assert.equal((await job(id)).state, "retry");
      } finally { await dropTrigger(trigger); await removeJobs([id]); }
    });
    await t.test("Ragic SQL apply plus checkpoint failure rolls venue creation back, then resumes same ID", async () => {
      const venueName = `synthetic-ew2-venue-${tag}`; ownedVenues.add(venueName);
      const checkpoint = { ...createRagicCheckpoint("2040-01-02"), phase: "apply_departments" as const,
        snapshots: { departments: [{ _ragicId: 1, "部門名稱": venueName, "營運性質": "synthetic-external" }], coaches: [], employees: [] } };
      const id = await sendJob(queues.notificationReconcile, { version: 1, kind: "ragic-sync", checkpoint });
      const trigger = await installTrigger("checkpoint", "data", `OLD.id='${id}'::uuid AND NEW.data IS DISTINCT FROM OLD.data`, "RAISE EXCEPTION 'ct_ew2_fixture_checkpoint_blocked'");
      try {
        const result = await wake(); assert.ok(result.failed > 0);
        assert.equal((await admin.query("SELECT count(*)::int n FROM venues WHERE name=$1", [venueName])).rows[0].n, 0);
        assert.deepEqual((await job(id)).data.checkpoint, checkpoint);
        await dropTrigger(trigger);
        const wait = await waitOwnRetryDue(id);
        const recovered = await wake(); assert.equal(recovered.failed, 0);
        const saved = await job(id);
        assert.equal(saved.id, id); assert.equal(saved.state, "completed");
        assert.ok(saved.started_on.getTime() >= wait.startAfter.getTime());
        assert.equal(saved.data.checkpoint.phase, "complete"); assert.equal(saved.data.checkpoint.counts.venuesAdded, 1);
        assert.equal((await admin.query("SELECT count(*)::int n FROM venues WHERE name=$1", [venueName])).rows[0].n, 1);
        t.diagnostic(JSON.stringify({ fixture: tag, case: "ragic_real_retry_due", jobId: id, ...wait, startedOnAfterRecovery: saved.started_on }));
      } finally { if (triggers.has(trigger)) await dropTrigger(trigger); await removeJobs([id]); await admin.query("DELETE FROM venues WHERE name=$1", [venueName]); }
    });
    await t.test("400 saved generic recipients persist a JSON cursor across wakes and retain every original key/body", async () => {
      const runId = randomUUID();
      const recipients = Array.from({ length: 400 }, (_, i) => {
        const id = randomUUID(), retryKey = randomUUID();
        return { id, retryKey, deliveryKey: `${tag}:delivery:${i}`, to: `synthetic-ew2-dest-${i}`, text: `synthetic-ew2-message-${i}` };
      });
      const parent = runId;
      await admin.query(`INSERT INTO weekly_push_runs(id,push_type,week_start_date,week_end_date,trigger_source,destination,idempotency_key,status,dry_run,total_count)
        VALUES($1,'notification','2040-01-02','2040-01-02','manual',$2,$3,'queued',false,400)`, [runId, `synthetic:${runId}`, `${tag}:run:${runId}`]);
      ownedRuns.add(runId);
      for (const id of [parent, wakeJobId(`wake-reconcile-parent:v1:${runId}`), wakeJobId(`wake-finalize:v1:${runId}`),
        ...recipients.map(row => wakeJobId(`wake-recipient:v1:${runId}:${row.id}`))]) ownedJobs.add(id);
      await admin.query(`INSERT INTO weekly_push_recipients(id,run_id,recipient_type,recipient_name,line_user_id,status,delivery_key,line_retry_key,payload_json)
        SELECT x->>'id',$1,'notification','synthetic-ew2-recipient',x->>'to','pending',x->>'deliveryKey',x->>'retryKey',
          jsonb_build_object('message',x->>'text','fixedDelivery',jsonb_build_object('notificationId',x->>'id','to',x->>'to','text',x->>'text','retryKey',x->>'retryKey'))
        FROM jsonb_array_elements($2::jsonb) x`, [runId, JSON.stringify(recipients)]);
      await sendJob(queues.notificationDelivery, { runId }, parent);
      const immutable = async () => (await admin.query("SELECT id,delivery_key,line_retry_key,payload_json->'fixedDelivery' fixed FROM weekly_push_recipients WHERE run_id=$1 ORDER BY id", [runId])).rows;
      const before = await immutable();
      const throttle = await installTrigger("chunk_budget", "data", `OLD.id='${parent}'::uuid AND NEW.data->>'cursor' IS NOT NULL`, "PERFORM pg_sleep(2.2)");
      let wakes = 0, totalWaitMs = 0;
      const realRetryWaits: { waitMs: number; startAfter: Date; startedOnBeforeWait: Date | null }[] = [];
      allowLine = true;
      try {
        const first = await wake(); wakes++;
        assert.equal(first.failed, 0); assert.equal(first.remainingWork, true);
        const saved = await job(parent);
        assert.equal(saved.state, "retry"); assert.ok(typeof saved.data.cursor === "string");
        assert.ok(saved.data.continuations > 0 && saved.data.continuations < 16);
        await dropTrigger(throttle);
        for (; wakes < 12; wakes++) {
          const runnable = (await admin.query("SELECT count(*)::int n FROM pgboss.job WHERE data->>'runId'=$1 AND state<'active' AND start_after<clock_timestamp()", [runId])).rows[0].n;
          if (runnable === 0) {
            const wait = await waitOwnRetryDue(wakeJobId(`wake-finalize:v1:${runId}`), 75_000 - totalWaitMs);
            totalWaitMs += wait.waitMs; realRetryWaits.push(wait);
          }
          const result = await wake(); assert.equal(result.failed, 0);
          const run = (await admin.query("SELECT status,completed_at,success_count FROM weekly_push_runs WHERE id=$1", [runId])).rows[0];
          if (run.completed_at) { assert.equal(run.status, "success"); assert.equal(run.success_count, 400); wakes++; break; }
        }
        assert.ok(wakes > 1 && wakes <= 12);
        const finished = (await admin.query("SELECT status,completed_at,success_count FROM weekly_push_runs WHERE id=$1", [runId])).rows[0];
        assert.ok(finished.completed_at); assert.equal(finished.status, "success"); assert.equal(finished.success_count, 400);
        assert.equal((await admin.query("SELECT count(*)::int n FROM weekly_push_recipients WHERE run_id=$1 AND status='accepted'", [runId])).rows[0].n, 400);
        assert.deepEqual(await immutable(), before);
        assert.equal(accepted.size, 400); assert.equal(lineCalls, 400); assert.equal(forbiddenHttp, 0);
        const jobs = (await admin.query("SELECT count(*)::int n,count(DISTINCT id)::int distinct_ids FROM pgboss.job WHERE name=$1 AND data->>'runId'=$2", [queues.weeklyPushRecipient, runId])).rows[0];
        assert.equal(jobs.n, 400); assert.equal(jobs.distinct_ids, 400);
        const finalizer = await job(wakeJobId(`wake-finalize:v1:${runId}`));
        for (const wait of realRetryWaits) assert.ok(finalizer.started_on.getTime() >= wait.startAfter.getTime());
        assert.ok(totalWaitMs <= 75_000);
        t.diagnostic(JSON.stringify({ fixture: tag, runId, recipients: 400, acceptedSavedKeys: accepted.size, wakes, totalWaitMs, realRetryWaits, finalizerStartedOn: finalizer.started_on }));
      } finally { allowLine = false; if (triggers.has(throttle)) await dropTrigger(throttle); }
    });
    assert.equal(forbiddenHttp, 0);
  } finally {
    try {
      if (connected) {
        const cleanupFailures: string[] = [];
        const cleanup = async (code: string, action: () => Promise<unknown>) => {
          try { await action(); } catch { cleanupFailures.push(code); }
        };
        for (const name of triggers) {
          await cleanup("trigger", () => admin.query(`DROP TRIGGER IF EXISTS ${quote(name)} ON pgboss.job`));
          await cleanup("function", () => admin.query(`DROP FUNCTION IF EXISTS pgboss.${quote(name)}()`));
        }
        await cleanup("jobs", () => admin.query("DELETE FROM pgboss.job WHERE id=ANY($1::uuid[])", [[...ownedJobs]]));
        await cleanup("archive", () => admin.query("DELETE FROM pgboss.archive WHERE id=ANY($1::uuid[])", [[...ownedJobs]]));
        await cleanup("runs", () => admin.query("DELETE FROM weekly_push_runs WHERE id=ANY($1::varchar[])", [[...ownedRuns]]));
        await cleanup("venues", () => admin.query("DELETE FROM venues WHERE name=ANY($1::varchar[])", [[...ownedVenues]]));
        for (const role of ownedRoles) {
          await cleanup("role_grant", () => admin.query(`REVOKE CONNECT ON DATABASE ${quote(target.pathname.slice(1))} FROM ${quote(role)}`));
          await cleanup("role", () => admin.query(`DROP ROLE ${quote(role)}`));
        }
        if (cleanupFailures.length) throw Error(`fixture_cleanup_failed:${cleanupFailures.join(",")}`);
        const leftovers = (await admin.query(`SELECT
          (SELECT count(*) FROM pgboss.job WHERE id=ANY($1::uuid[]))+
          (SELECT count(*) FROM pgboss.archive WHERE id=ANY($1::uuid[]))+
          (SELECT count(*) FROM weekly_push_runs WHERE id=ANY($2::varchar[]))+
          (SELECT count(*) FROM venues WHERE name=ANY($3::varchar[]))+
          (SELECT count(*) FROM pg_roles WHERE rolname=ANY($4::text[])) n`, [[...ownedJobs], [...ownedRuns], [...ownedVenues], [...ownedRoles]])).rows[0];
        assert.equal(Number(leftovers.n), 0);
        t.diagnostic(JSON.stringify({ fixture: tag, ownRunCount: ownedRuns.size, ownJobCount: ownedJobs.size, ownFixtureRowsRemaining: 0, realOutboundHttp: 0 }));
      }
    } finally {
      try { await appPool?.end(); }
      finally {
        try { if (connected) await admin.end(); }
        finally {
          globalThis.fetch = originalFetch;
          for (const [name, value] of [["NOTIFICATION_WAKE_MODE", originalMode], ["NOTIFICATION_WAKE_ENABLED", originalEnabled], ["NOTIFICATION_WAKE_NOT_BEFORE", originalNotBefore]] as const) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
          }
        }
      }
    }
  }
});
