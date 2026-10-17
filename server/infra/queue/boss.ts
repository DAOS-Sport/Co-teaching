/**
 * pg-boss singleton wrapper (Task #23).
 *
 * pg-boss owns its own `pgboss` schema inside the same Postgres instance
 * referenced by `DATABASE_URL`, so we don't need a separate Redis. We
 * only ever construct one PgBoss per process; `getBoss()` is the single
 * entry-point for both producers (enqueue) and the worker bootstrap.
 *
 * Lifecycle:
 *   - `startBoss()` is idempotent and lazily creates the instance.
 *   - `stopBoss()` is wired into SIGTERM/SIGINT so jobs can drain.
 *   - The instance is never re-used across process restarts; pg-boss
 *     itself stores job state in PG, so a fresh boot picks up where
 *     the previous one left off.
 */
import PgBoss from "pg-boss";
import { env } from "../../config/env";

let bossInstance: PgBoss | null = null;
let producerInstance: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;
let stopPromise: Promise<void> | null = null;
let shutdownHooked = false;

function buildBoss(): PgBoss {
  return new PgBoss({
    connectionString: env.databaseUrl,
    // Keep a small pool so we don't fight the main app for connections.
    max: 4,
    migrate: false,
    // Default retry policy — individual jobs may override per-publish.
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    // Auto-clean completed/failed jobs after a week so the table doesn't grow unbounded.
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
  });
}

function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const handler = async (signal: string) => {
    console.log(`[boss] ${signal} received — stopping pg-boss`);
    await stopBoss().catch((e) => console.error("[boss] stop error", e));
  };
  process.once("SIGTERM", () => void handler("SIGTERM"));
  process.once("SIGINT", () => void handler("SIGINT"));
}

/**
 * Start (or return the already-started) pg-boss instance. Safe to call
 * multiple times concurrently; the second caller awaits the first.
 */
export async function startBoss(): Promise<PgBoss> {
  if (stopPromise) await stopPromise;
  if (bossInstance) return bossInstance;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const boss = buildBoss();
    boss.on("error", (err) => {
      console.error("[boss] runtime error", err);
    });
    await boss.start();
    bossInstance = boss;
    hookShutdown();
    console.log("[boss] pg-boss started");
    return boss;
  })();

  try {
    return await startPromise;
  } catch (err) {
    startPromise = null;
    throw err;
  }
}

/** Returns the running boss; throws if `startBoss()` has not been awaited. */
export function getBoss(): PgBoss {
  if (!bossInstance) {
    throw new Error("[boss] pg-boss has not been started. Call startBoss() first.");
  }
  return bossInstance;
}

/** Producer methods use the caller's DB transaction; no start/migration/worker is run. */
export function getQueueProducer(): PgBoss {
  return bossInstance ?? (producerInstance ??= buildBoss());
}

export function setQueueProducerForTest(producer: PgBoss | null) { producerInstance = producer; }

export async function stopBoss(): Promise<void> {
  if (stopPromise) return stopPromise;
  if (!bossInstance && startPromise) await startPromise;
  const b = bossInstance;
  if (!b) return;
  stopPromise = (async () => {
    await b.stop({ graceful: true, timeout: 30_000 });
    if (bossInstance === b) { bossInstance = null; startPromise = null; }
  })();
  try { await stopPromise; } finally { stopPromise = null; }
}
