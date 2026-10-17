import { wakeExecutionConfig } from './wake-config';
import { boundedNativePg } from '../../infra/queue/bounded-native-pg';
import { runInOperationScope } from '../../shared/http/operationScope';
export const externalWakeConfigured=()=>process.env.NOTIFICATION_WAKE_ENABLED==='true';
/** Queried only by an authenticated operator; no SQL is executed during import/boot. */
export async function getWakeReadiness() {
  const config=wakeExecutionConfig();
  const base={mode:config.mode,intakeReady:false,executorFresh:false,lastWakeAt:null as string|null,backlog:0,failed:0,unknown:0,unresolved:0,oldestPendingAt:null as string|null,ragicStatus:'unknown',missedOrUnplanned:[] as string[]};
  if(!config.enabled)return {...base,ready:false,code:'wake_disabled'};
  if(!process.env.DATABASE_URL)throw Error('wake_database_unconfigured');
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),8000);
  let owned:ReturnType<typeof boundedNativePg>|undefined;
  try {
    owned=runInOperationScope({signal:ctrl.signal,deadlineMs:Date.now()+8000,abort:()=>ctrl.abort()},()=>boundedNativePg(process.env.DATABASE_URL!,{readOnly:true}));
    const c=owned.client;
    await c.connect();
    const receipt=(await c.query("SELECT completed_on,output,data FROM pgboss.job WHERE name='notification-reconcile' AND data->>'kind'='wake-heartbeat' AND state='completed' ORDER BY completed_on DESC LIMIT 1")).rows[0];
    const stats=(await c.query("SELECT count(*) FILTER(WHERE state<'completed')::int backlog,count(*) FILTER(WHERE state='failed')::int failed,min(created_on) FILTER(WHERE state<'completed') oldest FROM pgboss.job")).rows[0];
    const unknown=(await c.query("SELECT count(*)::int n FROM weekly_push_recipients WHERE status='unknown'")).rows[0].n;
    const daily=(await c.query("SELECT COALESCE(sum((output->>'unresolved')::int),0)::int n FROM pgboss.job WHERE name IN ('notification-daily-trigger','notification-weekly-trigger','notification-reconcile') AND data->>'kind' IS DISTINCT FROM 'wake-heartbeat'")).rows[0].n;
    const ragic=(await c.query("SELECT state,data->'checkpoint'->>'status' status FROM pgboss.job WHERE name='notification-reconcile' AND data->>'kind'='ragic-sync' ORDER BY created_on DESC LIMIT 1")).rows[0];
    const lastWakeAt=receipt?.completed_on?new Date(receipt.completed_on).toISOString():null;
    const executorFresh=!!lastWakeAt&&Date.now()-Date.parse(lastWakeAt)<15*60_000&&receipt.output?.mode==='active';
    const intakeReady=config.mode==='active'&&executorFresh;
    const {dueWakeSlots}=await import('../../core/notifications/wake-plan');
    const {createHash}=await import('node:crypto');
    const missedOrUnplanned:string[]=[];
    if(receipt?.data?.gapSince)missedOrUnplanned.push(`wake_gap_since:${receipt.data.gapSince}`);
    for(const slot of dueWakeSlots(Date.now(),config.notBefore)) {
      const h=createHash('sha256').update(slot.key).digest('hex');const id=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
      const row=(await c.query('SELECT state FROM pgboss.job WHERE id=$1 UNION ALL SELECT state FROM pgboss.archive WHERE id=$1 LIMIT 1',[id])).rows[0];
      if(!row||row.state==='failed')missedOrUnplanned.push(`${slot.kind}:${slot.date}`);
    }
    return {...base,ready:intakeReady,intakeReady,executorFresh,lastWakeAt,backlog:stats.backlog,failed:stats.failed,unknown,unresolved:daily,
      oldestPendingAt:stats.oldest?new Date(stats.oldest).toISOString():null,ragicStatus:ragic?.status??ragic?.state??'unknown',missedOrUnplanned,
      code:!executorFresh?'wake_stale_or_unverified':stats.failed||unknown||daily||missedOrUnplanned.length||ragic?.status==='partial_failed'?'wake_attention_required':'wake_fresh'};
  }finally{clearTimeout(timer);await owned?.dispose();}
}
