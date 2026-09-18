import { sql } from "drizzle-orm";
import { db } from "../db";
import { actorContext } from "./auth/auditContext";

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function audit(tx: Transaction, entity: string, id: string, before: unknown, after: unknown) {
  const actor = actorContext.getStore();
  await tx.execute(sql`INSERT INTO operation_audit (actor_id, actor_role, request_id, entity, entity_id, before_data, after_data, override_reason)
    VALUES (${actor?.id ?? "system:unattributed"}, ${actor?.role ?? "system"}, ${actor?.requestId ?? null}, ${entity}, ${id},
      ${JSON.stringify(before ?? null)}::jsonb, ${JSON.stringify(after ?? null)}::jsonb, ${actor?.overrideReason ?? null})`);
}

export class MutationError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
