import { getBoss } from "../../infra/queue/boss";
import { weeklyPushRepo } from "./weeklyPush.repository";

export async function dispatchWeeklyPushOutbox(): Promise<void> {
  const boss = getBoss();
  const rows = await weeklyPushRepo.listPendingOutbox();
  for (const row of rows) {
    try {
      const payload = row.payloadJson as { runId?: string };
      if (!payload.runId) throw new Error("outbox payload missing runId");
      await boss.send(row.queueName, { runId: payload.runId }, {
        singletonKey: `outbox:${row.runId}`,
        retryLimit: 0,
      });
      await weeklyPushRepo.markOutboxPublished(row.id);
    } catch (err) {
      await weeklyPushRepo.markOutboxFailed(
        row.id,
        row.attemptCount + 1,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
