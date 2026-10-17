import { sql, type SQL } from "drizzle-orm";
import type PgBoss from "pg-boss";

/** Bind pg-boss 10.4's parameterized INSERT to the caller's transaction executor. */
export function queueTransactionDb(executor: { execute(query: SQL): Promise<{ rows: unknown[] }> }): PgBoss.Db {
  return { async executeSql(text, values) {
    const pieces: SQL[] = [];
    let cursor = 0;
    const tokens = /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_][A-Za-z_0-9]*|)\$[\s\S]*?\$\1\$|\$(\d+)\b/g;
    for (const match of Array.from(text.matchAll(tokens))) {
      if (!match[2]) continue;
      const index = Number(match[2]) - 1;
      if (index < 0 || index >= values.length) throw new Error("Invalid queue SQL parameter");
      // Drizzle deliberately omits an undefined interpolation. pg-boss uses undefined
      // for default options, so bind an explicit NULL instead of losing the SQL slot.
      const value = values[index] ?? null;
      const bound = value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) ? JSON.stringify(value) : value;
      pieces.push(sql.raw(text.slice(cursor, match.index)), sql`${sql.param(bound)}`);
      cursor = match.index! + match[0].length;
    }
    pieces.push(sql.raw(text.slice(cursor)));
    return executor.execute(sql.join(pieces, sql.raw(""))) as Promise<{ rows: any[] }>;
  } };
}
