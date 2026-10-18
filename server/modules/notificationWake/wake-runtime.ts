import PgBoss from 'pg-boss';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@shared/schema';
import { assertNotificationSchema } from '../../infra/queue/preflight';
import { queues } from '../../infra/queue/queues';
import { withQueueProducer } from '../../infra/queue/boss';
import { withDbScope, inTransaction } from '../../shared/dbContext';
import { assertOperationActive, currentOperation, remainingOperationMs, stopOperation } from '../../shared/http/operationScope';
import { dueWakeSlots } from '../../core/notifications/wake-plan';
import { weeklyPushRepo } from '../weeklyPush/weeklyPush.repository';
import { enqueueWeeklyPush } from '../weeklyPush/weeklyPush.service';
import { deliverSavedRecipient } from '../notification/delivery.service';
import { finalizeWeeklyPushRun } from '../weeklyPush/weeklyPush.worker';
import { fanoutWeeklyRun, handleBoundedRecipient } from './notification-batch';
import { wakeExecutionConfig } from './wake-config';
import type { BoundedJob, JobStep } from './bounded-drain';
import { wakeJobId } from './wake-identities';
import { boundedNativePg } from '../../infra/queue/bounded-native-pg';
import { wakeCoverageReceipt } from '../../core/notifications/wake-coverage';
export { wakeJobId } from './wake-identities';

const LOCK=1_927_741_305;
const processQueues=[queues.notificationWeeklyTrigger,queues.notificationDailyTrigger,queues.notificationReconcile,queues.weeklyPush,queues.notificationDelivery,queues.weeklyPushRecipient,queues.weeklyPushReport];
type WakeReply={version:1;status:'busy'|'drained'|'remaining'|'disabled';remainingWork:boolean;processed:number;failed:number};
/** Only called after verified OIDC. No polling worker or timekeeper is started. */
export async function executeNotificationWake():Promise<WakeReply> {
  assertOperationActive(5000);
  const config=wakeExecutionConfig();
  if(!config.enabled) return {version:1,status:'disabled',remainingWork:false,processed:0,failed:0};
  if(!process.env.DATABASE_URL)throw Error('wake_database_unconfigured');
  const ownedPg=boundedNativePg(process.env.DATABASE_URL),client=ownedPg.client;
  let connected=false,locked=false,failed=0,processed=0,sqlFailure:unknown=null;
  client.on('error',()=>{sqlFailure=Error('wake_connection_lost');stopOperation();});
  const control={signal:currentOperation()?.signal,deadlineMs:currentOperation()?.deadlineMs,
    shouldContinue:()=>!currentOperation()?.signal.aborted && remainingOperationMs(Infinity,12000)>0};
  const executeSql=async(text:string,values?:any[])=> {
    try{return await client.query(text,values);}catch(error){sqlFailure=error;throw error;}
  };
  const boss=new PgBoss({db:{executeSql},migrate:false,schedule:false,supervise:false});
  boss.on('error',()=>{sqlFailure=Error('wake_queue_error');});
  const sendOnce=async(name:string,key:string,data:object)=>{
    assertOperationActive(3000);
    const id=wakeJobId(key);
    const existing=await client.query('SELECT id FROM pgboss.job WHERE name=$1 AND id=$2 UNION ALL SELECT id FROM pgboss.archive WHERE name=$1 AND id=$2 LIMIT 1',[name,id]);
    if(existing.rows.length)return;
    const sent=await boss.send(name,data,{id,retryLimit:20,retryDelay:60,expireInSeconds:45});
    if(!sent)throw Error('wake_enqueue_unconfirmed');
  };
  const recipientJob=async(runId:string,recipientId:string)=>sendOnce(queues.weeklyPushRecipient,`wake-recipient:v1:${runId}:${recipientId}`,{runId,recipientId});
  const reportJob=async(runId:string)=>sendOnce(queues.weeklyPushReport,`wake-finalize:v1:${runId}`,{runId});
  const step=async(job:BoundedJob):Promise<JobStep>=>{
    assertOperationActive(3000);
    const d=job.data;
    if(job.name===queues.notificationReconcile) {
      // A request may stop after persisting its receipt but before marking it complete.
      if(d.kind==='wake-heartbeat')return {complete:true};
      if(d.kind==='ragic-sync') {
        const {createRagicCheckpoint}=await import('./ragic-checkpoint');
        const {advanceBoundedRagicSync}=await import('../../ragic');
        const result=await advanceBoundedRagicSync(d.checkpoint??createRagicCheckpoint(d.targetDate),control as any);
        return {complete:result.complete,data:{...d,checkpoint:result.data,unresolved:result.data.failures?.length??0}};
      }
      throw Error('wake_reconcile_kind_unrecognized');
    }
    if(job.name===queues.notificationWeeklyTrigger) {
      if(d.kind!=='weekly'||!/^\d{4}-\d{2}-\d{2}$/.test(d.targetDate))throw Error('wake_slot_invalid');
      const end=new Date(Date.parse(d.targetDate+'T00:00:00Z')+6*86400000).toISOString().slice(0,10);
      if(Date.now()>=Date.parse(d.targetDate+'T00:00:00+08:00') && !await weeklyPushRepo.getRunByIdempotencyKey(`weekly-send:${d.targetDate}:coaches`))
        return {complete:true,data:{...d,missed:true,unresolved:1}};
      await enqueueWeeklyPush({weekStartDate:d.targetDate,weekEndDate:end,triggerSource:'cron',latestCreateAt:Date.parse(d.targetDate+'T00:00:00+08:00')});
      return {complete:true};
    }
    if(job.name===queues.notificationDailyTrigger) {
      const {prepareDailyNotifications,enqueuePreparedDailyNotifications}=await import('../../line-notify');
      if(d.kind!=='daily'||!/^\d{4}-\d{2}-\d{2}$/.test(d.targetDate))throw Error('wake_slot_invalid');
      if(!d.plan&&Date.now()>=Date.parse(d.targetDate+'T00:00:00+08:00'))return {complete:true,data:{...d,missed:true,unresolved:1}};
      const plan=d.plan ?? await prepareDailyNotifications(d.targetDate,control);
      const result=await enqueuePreparedDailyNotifications(plan,{...control,limit:25,cursor:d.cursor??null,latestCreateAt:Date.parse(d.targetDate+'T00:00:00+08:00')});
      return {complete:result.complete,data:{...d,plan,cursor:result.nextCursor,
        unresolved:(d.unresolved??0)+result.unknown+result.ambiguous}};
    }
    if(job.name===queues.weeklyPush||job.name===queues.notificationDelivery) {
      const result=await fanoutWeeklyRun(d.runId,{
        ...weeklyPushRepo,enqueueRecipientJob:recipientJob,
      },{...control,limit:25,cursor:d.cursor??null});
      if(result.complete)await reportJob(d.runId);
      return {complete:result.complete,data:{...d,cursor:result.nextCursor}};
    }
    if(job.name===queues.weeklyPushRecipient) {
      const result=await handleBoundedRecipient(d,{...weeklyPushRepo,deliverSavedRecipient},control);
      return {complete:result.settled,retryAt:result.retry?new Date(Date.now()+60_000):undefined};
    }
    if(job.name===queues.weeklyPushReport) {
      const run=await weeklyPushRepo.getRunById(d.runId);
      if(!run)throw Error('wake_run_not_found');
      if(run.completedAt)return {complete:true};
      const counts=await weeklyPushRepo.countRecipientStatuses(run.id);
      if(counts.pending+counts.sending+counts.retryWait>0)return {complete:false,retryAt:new Date(Date.now()+60_000)};
      await finalizeWeeklyPushRun(run,counts);
      return {complete:true};
    }
    throw Error('wake_queue_unrecognized');
  };
  const acknowledge=async(job:BoundedJob,result:JobStep)=>{
    // Fence against timeout/reclaim. Checkpoints and chunk application share the caller's transaction.
    const updated=await client.query(`UPDATE pgboss.job SET data=$4::jsonb,state=$5::pgboss.job_state,
      completed_on=CASE WHEN $5='completed' THEN now() ELSE NULL END,
      start_after=COALESCE($6::timestamptz,now()),output=$7::jsonb
      WHERE name=$1 AND id=$2 AND state='active' AND started_on=$3 RETURNING id`,
      [job.name,job.id,job.startedOn,JSON.stringify({...result.data??job.data,continuations:(job.data.continuations??0)+(result.complete?0:1)}),result.complete?'completed':'retry',result.retryAt??null,
        JSON.stringify({version:1,complete:result.complete,unresolved:(result.data as any)?.unresolved??0})]);
    if(updated.rowCount!==1)throw Error('wake_ack_fence_lost');
    if(result.complete)failed+=Number((result.data as any)?.unresolved??0);
    if(!result.complete) {
      // Successful chunk continuation is not a failed attempt. Clear only this claim's start;
      // pg-boss's next fetch preserves retry_count, while data.continuations retains progress history.
      await client.query("UPDATE pgboss.job SET started_on=NULL WHERE name=$1 AND id=$2 AND state='retry' AND started_on=$3",[job.name,job.id,job.startedOn]);
    }
  };
  try {
    await client.connect();connected=true;
    await assertNotificationSchema(client);
    assertOperationActive(5000);
    locked=(await client.query('SELECT pg_try_advisory_lock($1) AS locked',[LOCK])).rows[0].locked===true;
    if(!locked)return {version:1,status:'busy',remainingWork:true,processed:0,failed:0};
    if((await client.query('SELECT count(*)::int AS n FROM pgboss.schedule')).rows[0].n!==0)throw Error('wake_legacy_schedule_still_registered');
    // These are solely the queue names in the already-approved cutover plan; no new schema/partition names.
    const existingNames=new Set((await client.query('SELECT name FROM pgboss.queue')).rows.map((r:any)=>r.name));
    for(const name of Object.values(queues)) {
      assertOperationActive(5000);
      if(!existingNames.has(name))await boss.createQueue(name);
    }
    if(config.mode==='active')await boss.expire();
    if(sqlFailure)throw Error('wake_queue_sql_failed');
    return await withDbScope(drizzle(client,{schema}),()=>withQueueProducer(boss,async()=>{
      const prior=(await client.query("SELECT completed_on,data FROM pgboss.job WHERE name='notification-reconcile' AND data->>'kind'='wake-heartbeat' AND state='completed' ORDER BY completed_on DESC LIMIT 1")).rows[0];
      let legacyCursor=prior?.data?.legacyCursor??null;
      const {gapSince,lastActiveCompleted}=wakeCoverageReceipt({now:Date.now(),notBefore:config.notBefore,mode:config.mode,previousCompleted:prior?.completed_on?new Date(prior.completed_on).getTime():null,previousData:prior?.data});
      if(config.mode==='active') {
        const drain=async()=> {
        // Round robin prevents a partially checkpointed parent starving saved recipients/reports.
        let cursor=0,empty=0;
        while(processed<100 && control.shouldContinue() && empty<processQueues.length) {
          const name=processQueues[cursor++%processQueues.length];sqlFailure=null;
          const jobs=await boss.fetch(name,{batchSize:1,includeMetadata:true});
          if(sqlFailure)throw Error('wake_fetch_sql_failed');
          const job=jobs[0] as BoundedJob|undefined;
          if(!job){empty++;continue;} empty=0;
          try {
            const transactional=[queues.notificationDailyTrigger,queues.notificationWeeklyTrigger,queues.notificationReconcile,queues.weeklyPush,queues.notificationDelivery].includes(name as any);
            if(transactional)await inTransaction(async()=>{const result=await step(job);await acknowledge(job,result);});
            else {const result=await step(job);await acknowledge(job,result);}
          } catch {
            failed++;
            const result=await client.query(`UPDATE pgboss.job SET
              state=CASE WHEN retry_count<retry_limit THEN 'retry'::pgboss.job_state ELSE 'failed'::pgboss.job_state END,
              start_after=now()+interval '60 seconds',completed_on=CASE WHEN retry_count>=retry_limit THEN now() ELSE NULL END,
              output='{"code":"wake_unit_failed"}'::jsonb
              WHERE name=$1 AND id=$2 AND state='active' AND started_on=$3 RETURNING id`,[name,job.id,job.startedOn]);
            if(result.rowCount!==1)throw Error('wake_failure_ack_fence_lost');
          }
          processed++;
        }
        };
        await drain();
        const planningDeadline=Math.min(Date.now()+2000,(currentOperation()?.deadlineMs??Date.now())-12000);
        if(control.shouldContinue()) {
          const {dispatchWeeklyPushOutbox}=await import('../weeklyPush/weeklyPush.outbox');
          await dispatchWeeklyPushOutbox({limit:1});
        }

        for(const slot of dueWakeSlots(Date.now(),config.notBefore)) {
          if(Date.now()>=planningDeadline||!control.shouldContinue())break;
          const name=slot.kind==='weekly'?queues.notificationWeeklyTrigger:slot.kind==='daily'?queues.notificationDailyTrigger:queues.notificationReconcile;
          await sendOnce(name,slot.key,{version:1,kind:slot.kind==='ragic'?'ragic-sync':slot.kind,targetDate:slot.targetDate});
        }
        // Persisted runs are resumed with their original IDs and payloads, including manual enqueues.
        if(Date.now()<planningDeadline&&control.shouldContinue()) {
          const run=await weeklyPushRepo.nextUnfinishedRun(legacyCursor);
          if(run) {
            await sendOnce(queues.weeklyPush,`wake-reconcile-parent:v1:${run.id}`,{runId:run.id});
            await reportJob(run.id);legacyCursor=run.id;
          }
        }

        await drain();
      }
      // Durable receipt on the existing reconciliation queue; it grants no business input or outbound ability.
      const heartbeatId=wakeJobId(`wake-heartbeat:v1:${Math.floor(Date.now()/300000)}`);
      await boss.send(queues.notificationReconcile,{version:1,kind:'wake-heartbeat',mode:config.mode},{id:heartbeatId});
      await client.query(`UPDATE pgboss.job SET state='completed',completed_on=now(),output=$2::jsonb,data=data||$4::jsonb WHERE name=$1 AND id=$3 AND data->>'kind'='wake-heartbeat'`,
        [queues.notificationReconcile,JSON.stringify({version:1,processed,failed,mode:config.mode}),heartbeatId,JSON.stringify({mode:config.mode,gapSince,legacyCursor,lastActiveCompleted})]);
      const n=(await client.query("SELECT count(*)::int n FROM pgboss.job WHERE name=ANY($1::text[]) AND state<'completed' AND data->>'kind' IS DISTINCT FROM 'wake-heartbeat'",[processQueues])).rows[0].n;
      return {version:1,status:n?'remaining':'drained',remainingWork:n>0,processed,failed};
    }));
  } finally {
    // All transport awaits have settled; the lock belongs to this same native session.
    if(connected&&locked)await client.query('SELECT pg_advisory_unlock($1)',[LOCK]).catch(()=>{});
    await ownedPg.dispose();
  }
}
