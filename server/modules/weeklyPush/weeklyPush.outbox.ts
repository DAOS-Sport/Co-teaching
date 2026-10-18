import { and, eq, lte, or, isNull } from "drizzle-orm";
import { weeklyPushOutbox } from "@shared/schema";
import { currentDb, inTransaction } from "../../shared/dbContext";
import { getQueueProducer } from "../../infra/queue/boss";
import { queueTransactionDb } from "../../infra/queue/transaction";
import { assertOperationActive } from '../../shared/http/operationScope';

/** Recovery for existing outbox records only. New bundles enqueue directly in their transaction. */
export async function dispatchWeeklyPushOutbox(options:{limit?:number}={}) {
  const limit=options.limit??50;
  if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('outbox_batch_invalid');
  assertOperationActive(1500);
  return inTransaction(async () => {
    const tx = currentDb();
    const rows = await tx.select().from(weeklyPushOutbox).where(and(eq(weeklyPushOutbox.status, "pending"),
      or(isNull(weeklyPushOutbox.nextAttemptAt), lte(weeklyPushOutbox.nextAttemptAt, new Date())))).limit(limit).for("update", { skipLocked: true });
    const producer = getQueueProducer();
    for (const row of rows) {
      assertOperationActive(1500);
      const adapter = queueTransactionDb(tx);
      const data = row.payloadJson as { runId?: string };
      if (data.runId !== row.runId) throw new Error("Invalid saved outbox identity");
      const jobId = await producer.send(row.queueName, { runId: row.runId }, { id: row.runId, retryLimit: 3, db: adapter });
      if (!jobId && !await producer.getJobById(row.queueName, row.runId, { db: adapter, includeArchive: true })) throw new Error("Outbox queue is unavailable");
      await tx.update(weeklyPushOutbox).set({ status: "published", publishedAt: new Date(), updatedAt: new Date() }).where(eq(weeklyPushOutbox.id, row.id));
    }
    return { published: rows.length };
  });
}
