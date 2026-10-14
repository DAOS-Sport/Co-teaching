import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const activeTransaction = new AsyncLocalStorage<Tx>();

/**
 * The transaction this call runs inside, or the shared pool outside one.
 * Repositories use this so a route can make a business write and its
 * operation-audit row commit or roll back together.
 */
export function currentDb(): Db {
  return (activeTransaction.getStore() as unknown as Db | undefined) ?? db;
}

/** Runs `fn` in one transaction; nested calls join the outer one. */
export async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (activeTransaction.getStore()) return fn();
  return db.transaction((tx) => activeTransaction.run(tx, fn));
}
