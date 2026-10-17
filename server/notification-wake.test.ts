import test from 'node:test';
import assert from 'node:assert/strict';
import { dueWakeSlots } from './core/notifications/wake-plan';
import { runInOperationScope, assertOperationActive, remainingOperationMs } from './shared/http/operationScope';
import { drainBoundedJobs } from './modules/notificationWake/bounded-drain';
import { wakeCoverageGap, wakeCoverageReceipt } from './core/notifications/wake-coverage';

const epoch = '2026-10-17T04:00:00Z';
test('canary never advances active coverage or erases a gap across a reused receipt',()=>{
  const start=Date.parse(epoch),later=start+3*86400000;
  const canary=wakeCoverageReceipt({now:later-300000,notBefore:start,mode:'canary',previousCompleted:later-600000,previousData:{mode:'canary'}});
  const active=wakeCoverageReceipt({now:later,notBefore:start,mode:'active',previousCompleted:later-300000,previousData:{...canary,mode:'canary'}});
  assert.equal(active.gapSince,epoch.replace('Z','.000Z'));
  const switched=wakeCoverageReceipt({now:later+60000,notBefore:start,mode:'canary',previousCompleted:later,previousData:{...active,mode:'active'}});
  assert.equal(switched.lastActiveCompleted,new Date(later).toISOString());assert.equal(switched.gapSince,active.gapSince);
  const resumed=wakeCoverageReceipt({now:later+120000,notBefore:start,mode:'active',previousCompleted:later+60000,previousData:{...switched,mode:'canary'}});
  assert.equal(resumed.gapSince,active.gapSince);
});
test('cross-day wake gap persists through a fresh heartbeat and never creates a past slot',()=>{
  const gap=wakeCoverageGap({now:Date.parse('2026-10-18T16:01:00Z'),notBefore:Date.parse(epoch),previousCompleted:Date.parse('2026-10-17T08:00:00Z'),previousGap:null});
  assert.equal(gap,'2026-10-17T08:00:00.000Z');
  assert.equal(wakeCoverageGap({now:Date.parse('2026-10-18T16:02:00Z'),notBefore:Date.parse(epoch),previousCompleted:Date.parse('2026-10-18T16:01:00Z'),previousGap:gap}),gap);
  assert.equal(wakeCoverageGap({now:Date.parse(epoch)-1,notBefore:Date.parse(epoch),previousCompleted:null,previousGap:null}),null);
});
test('Taipei delayed daily slot freezes tomorrow and closes at midnight', () => {
  const a = dueWakeSlots(Date.parse('2026-10-17T11:07:00Z'), Date.parse(epoch));
  assert.deepEqual(a.map(x => [x.kind, x.targetDate]), [['daily', '2026-10-18']]);
  assert.equal(dueWakeSlots(Date.parse('2026-10-17T16:01:00Z'), Date.parse(epoch)).length, 0);
});
test('Sunday weekly opens at noon, freezes Monday, no historical lookback', () => {
  const before = dueWakeSlots(Date.parse('2026-10-18T03:59:59Z'), Date.parse(epoch));
  assert.equal(before.some(x => x.kind === 'weekly'), false);
  const after = dueWakeSlots(Date.parse('2026-10-18T04:05:01Z'), Date.parse(epoch));
  assert.deepEqual(after.find(x => x.kind === 'weekly')?.targetDate, '2026-10-19');
  assert.equal(dueWakeSlots(Date.parse('2026-10-19T04:05:01Z'), Date.parse(epoch)).some(x => x.kind === 'weekly'), false);
});
test('activation excludes already past slot; clock/config fail closed', () => {
  assert.equal(dueWakeSlots(Date.parse('2026-10-17T07:00:00Z'), Date.parse(epoch)).length, 0);
  assert.throws(() => dueWakeSlots(NaN, 0));
  assert.throws(() => dueWakeSlots(Date.now(), NaN));
});
test('operation scope is isolated and aborted scope refuses work', async () => {
  const c = new AbortController();
  await runInOperationScope({signal:c.signal,deadlineMs:Date.now()+1000}, async () => {
    assert.ok(remainingOperationMs(5000) <= 1000);
    c.abort(); assert.throws(() => assertOperationActive());
  });
  assert.doesNotThrow(() => assertOperationActive());
});
test('bounded drain awaits ack, never declares SQL error drained', async () => {
  let acked = false, handled = 0;
  const result = await drainBoundedJobs({
    async fetch(){ return handled ? null : {id:'one',name:'q',data:{}}; },
    async handle(){ handled++; return {complete:true}; },
    async acknowledge(){ await new Promise(r => setTimeout(r,5)); acked=true; },
  }, {maxJobs:2, shouldContinue:()=>true});
  assert.equal(acked,true); assert.equal(result.processed,1);
  await assert.rejects(drainBoundedJobs({async fetch(){throw Error('sql');},async handle(){return {complete:true};},async acknowledge(){}},{maxJobs:1,shouldContinue:()=>true}));
});
test('bounded drain does not claim after budget; ack error escapes', async () => {
  let fetched=0;
  await drainBoundedJobs({async fetch(){fetched++;return null;},async handle(){return {complete:true};},async acknowledge(){}},{maxJobs:1,shouldContinue:()=>false});
  assert.equal(fetched,0);
  await assert.rejects(drainBoundedJobs({async fetch(){return {id:'one',name:'q',data:{}};},async handle(){return {complete:true};},async acknowledge(){throw Error('ack');}},{maxJobs:1,shouldContinue:()=>true}));
});
