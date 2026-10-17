import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const activeTransaction = new AsyncLocalStorage<Tx>();
const scopedDb = new AsyncLocalStorage<Db>();
let baseDb: Db = db;
/** A wake owns one connection; concurrent HTTP calls never mutate the shared DB. */
export function withDbScope<T>(connection: unknown, fn: () => T): T {
  return scopedDb.run(connection as Db, fn);
}

/**
 * The transaction this call runs inside, or the shared pool outside one.
 * Repositories use this so a route can make a business write and its
 * operation-audit row commit or roll back together.
 */
export function currentDb(): Db {
  return (activeTransaction.getStore() as unknown as Db | undefined) ?? scopedDb.getStore() ?? baseDb;
}

export function isInTransaction(): boolean {
  return activeTransaction.getStore() !== undefined;
}

/** Runs `fn` in one transaction; nested calls join the outer one. */
export async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (activeTransaction.getStore()) return fn();
  return (scopedDb.getStore() ?? baseDb).transaction((tx) => activeTransaction.run(tx, fn));
}

/**
 * Drop-in for `db` that resolves to currentDb() on every use, so repository
 * code written against `db` joins the caller's transaction. Its own
 * `transaction()` becomes a savepoint inside one, never a second connection.
 */
export const txDb: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const target = currentDb();
    const value = Reflect.get(target as object, prop, target);
    return typeof value === "function" && prop !== "constructor" ? value.bind(target) : value;
  },
});

/** Tests: run against another database (or a stand-in) instead of the app pool. */
export function setBaseDbForTest(next: unknown): void {
  baseDb = (next as Db | null) ?? db;
}
