import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import ws from "ws";
import * as schema from "@shared/schema";
import { Pool as TcpPool } from "pg";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// TCP is useful for standard PostgreSQL and isolated integration tests.
export const pool = process.env.DATABASE_DRIVER === "pg"
  ? new TcpPool({ connectionString: process.env.DATABASE_URL }) as unknown as Pool
  : new Pool({ connectionString: process.env.DATABASE_URL });
const neonDb = drizzle({ client: pool, schema });
// Use the matching adapter: neon-serverless does not recognize a pg.Pool and
// otherwise fails to reserve one connection for BEGIN/COMMIT/ROLLBACK.
export const db = process.env.DATABASE_DRIVER === "pg"
  ? drizzlePg({ client: pool as unknown as TcpPool, schema }) as unknown as typeof neonDb
  : neonDb;
