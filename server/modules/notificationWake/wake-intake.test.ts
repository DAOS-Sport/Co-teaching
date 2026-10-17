import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function fixture(state:string|null){
 let sends=0;
 const module={exports:{} as any};
 const stubs:any={
  '../../infra/queue/boss':{getQueueProducer:()=>({getJobById:async()=>state?{state}:null,send:async()=>{sends++;return 'synthetic-job';}})},
  '../../shared/dbContext':{currentDb:()=>({}),inTransaction:async(f:any)=>f()},
  'drizzle-orm':{sql:()=>({})},'../weeklyPush/weeklyPush.repository':{weeklyPushRepo:{}},
  '../../infra/queue/transaction':{queueTransactionDb:()=>({})},
  '../../infra/queue/queues':{queues:{notificationDailyTrigger:'notification-daily-trigger',notificationReconcile:'notification-reconcile'}},
  './wake-readiness':{getWakeReadiness:async()=>({intakeReady:true})},'./wake-identities':{wakeJobId:()=> 'synthetic-job'},
 };
 const source=readFileSync(new URL('./wake-intake.ts',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(n:string)=>{assert.ok(n in stubs);return stubs[n];},Date});
 return {enqueue:module.exports.enqueueExternalDateJob,sends:()=>sends};
}
for(const kind of ['daily','ragic']){
 for(const state of ['failed','cancelled'])test(`${kind} terminal ${state} cannot report queued`,async()=>{
  const f=fixture(state);await assert.rejects(f.enqueue(kind),{message:'external_wake_date_job_requires_review'});assert.equal(f.sends(),0);
 });
 test(`${kind} completed receipt explicitly says no work queued`,async()=>{
  const f=fixture('completed'),r=await f.enqueue(kind);assert.equal(r.queued,false);assert.equal(r.state,'completed');assert.equal(f.sends(),0);
 });
 test(`${kind} pending receipt reuses the saved identity`,async()=>{
  const f=fixture('retry'),r=await f.enqueue(kind);assert.equal(r.queued,true);assert.equal(r.reused,true);assert.equal(f.sends(),0);
 });
}
