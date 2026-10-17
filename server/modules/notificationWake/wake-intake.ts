import { getQueueProducer } from '../../infra/queue/boss';
import { currentDb, inTransaction } from '../../shared/dbContext';
import { sql } from 'drizzle-orm';
import { weeklyPushRepo } from '../weeklyPush/weeklyPush.repository';
import { queueTransactionDb } from '../../infra/queue/transaction';
import { queues } from '../../infra/queue/queues';
import { getWakeReadiness } from './wake-readiness';
import { wakeJobId } from './wake-identities';
/** Authenticated admin chooses no identity or source payload. A day's saved job is reused. */
export async function enqueueExternalDateJob(kind:'daily'|'ragic') {
  if(!(await getWakeReadiness()).intakeReady)throw Error('external_wake_intake_unready');
  const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const targetDate=kind==='daily'?new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10):date;
  const id=wakeJobId(`external-wake:v1:${kind}:${date}`);
  const name=kind==='daily'?queues.notificationDailyTrigger:queues.notificationReconcile;
  const boss=getQueueProducer(),db=queueTransactionDb(currentDb());
  const existing=await boss.getJobById(name,id,{includeArchive:true,db});
  if(existing && !['created','retry','active','completed'].includes(existing.state))throw Error('external_wake_date_job_requires_review');
  if(existing?.state==='completed')return {queued:false,reused:true,state:'completed',jobId:id,targetDate};
  if(!existing&&!await boss.send(name,{version:1,kind:kind==='ragic'?'ragic-sync':kind,targetDate},{id,db,expireInSeconds:45,retryLimit:20,retryDelay:60}))throw Error('external_wake_enqueue_unconfirmed');
  return {queued:true,reused:!!existing,state:existing?.state??'created',jobId:id,targetDate};
}

/** Explicit admin recovery preserves every recipient, payload and LINE key. No transport runs here. */
export async function enqueueSavedRunRecovery(runId:string) {
  if(!(await getWakeReadiness()).intakeReady)throw Error('external_wake_intake_unready');
  const run=await weeklyPushRepo.getRunById(runId);
  if(!run)throw Error('weekly_push_run_not_found');
  if(run.completedAt)return {queued:false,reused:true,runId};
  return inTransaction(async()=>{
    const tx=currentDb(),boss=getQueueProducer(),db=queueTransactionDb(tx);
    const archived=await tx.execute(sql`SELECT id FROM pgboss.archive WHERE name IN ('weekly-push','notification-delivery','weekly-push-recipient','weekly-push-report') AND state='failed' AND data->>'runId'=${runId} LIMIT 1`);
    if(archived.rows.length)throw Error('wake_archived_recovery_requires_review');
    await tx.execute(sql`UPDATE pgboss.job SET state='retry',retry_count=0,started_on=NULL,completed_on=NULL,start_after=now(),
      data=jsonb_set(data,'{recoveries}',COALESCE(data->'recoveries','[]'::jsonb)||jsonb_build_array(jsonb_build_object('at',now(),'previous',output,'retry_count',retry_count,'state',state,'started_on',started_on)))
      WHERE name IN ('weekly-push','notification-delivery','weekly-push-recipient','weekly-push-report') AND state='failed' AND data->>'runId'=${runId}`);
    for(const [name,key] of [[queues.weeklyPush,`wake-reconcile-parent:v1:${runId}`],[queues.weeklyPushReport,`wake-finalize:v1:${runId}`]]) {
      const id=wakeJobId(key);
      if(!await boss.getJobById(name,id,{db,includeArchive:true})&&!await boss.send(name,{runId},{id,db,retryLimit:20,expireInSeconds:45}))throw Error('external_wake_enqueue_unconfirmed');
    }
    return {queued:true,reused:true,runId};
  });
}
