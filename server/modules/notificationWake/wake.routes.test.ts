import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { notificationWakeHandler } from './wake.routes';
import { GithubWakeIdentityError } from '../../infra/auth/githubWakeIdentity';
import { currentOperation } from '../../shared/http/operationScope';

async function fixture(t:any,deps:any) {
  const previous={...process.env};
  process.env.NOTIFICATION_WAKE_ENABLED='true';
  process.env.NOTIFICATION_WAKE_AUDIENCE='https://swim-scheduler-ronchen2.replit.app/api/internal/notification-wake';
  const app=express();app.use(express.json());app.post('/wake',notificationWakeHandler(deps));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(async()=>{process.env=previous;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  return `http://127.0.0.1:${(server.address() as any).port}/wake`;
}
test('disabled and rejected auth never enter runtime or create wake DB',async t=>{
  let calls=0,verified=0;
  const url=await fixture(t,{verify:async()=>{verified++;throw new GithubWakeIdentityError('JWT_SIGNATURE_REJECTED');},execute:async()=>{calls++;}});
  let res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":1}'});
  assert.equal(res.status,401);assert.equal(calls,0);assert.equal(verified,1);
  process.env.NOTIFICATION_WAKE_ENABLED='false';
  res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":1}'});
  assert.equal(res.status,503);assert.equal(calls,0);assert.equal(verified,1);
});
test('strict body rejects arbitrary recipient/date/command after auth',async t=>{
  let calls=0;const url=await fixture(t,{verify:async()=>({}),execute:async()=>{calls++;}});
  for(const body of [{version:1,date:'2026-01-01'},{version:1,to:'fixture'},{version:1,command:'anything'},[],{}]) {
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(res.status,400);
  }
  assert.equal(calls,0);
});
test('response waits for execute; errors are static and busy remains incomplete',async t=>{
  let settled=false;
  const url=await fixture(t,{verify:async()=>({}),execute:async()=>{await new Promise(r=>setTimeout(r,5));settled=true;return {version:1,status:'busy',remainingWork:true,processed:0,failed:0};}});
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":1}'});
  assert.equal(res.status,409);assert.equal(settled,true);assert.equal((await res.json()).remainingWork,true);
});
test('client disconnect aborts the scope and runtime settles without detached work',async t=>{
  let started=false,settled=false;
  const url=await fixture(t,{verify:async()=>({}),execute:async()=>{
    const scope=currentOperation()!;started=true;
    await new Promise<void>(r=>scope.signal.addEventListener('abort',()=>r(),{once:true}));
    await new Promise(r=>setTimeout(r,5));settled=true;
    return {version:1,status:'remaining',remainingWork:true,processed:0,failed:0};
  }});
  const c=new AbortController();const pending=fetch(url,{method:'POST',signal:c.signal,headers:{'Content-Type':'application/json'},body:'{"version":1}'}).catch(()=>null);
  while(!started)await new Promise(r=>setTimeout(r,2));c.abort();await pending;
  for(let i=0;i<50&&!settled;i++)await new Promise(r=>setTimeout(r,2));assert.equal(settled,true);
});
test('runtime failure never leaks raw database/auth values',async t=>{
  const url=await fixture(t,{verify:async()=>({}),execute:async()=>{throw Error('fixture-sensitive-detail');}});
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":1}'});
  assert.equal(res.status,503);assert.deepEqual(await res.json(),{code:'WAKE_EXECUTION_INCOMPLETE'});
});
test('backend exit uncertainty remains an explicit failure',async t=>{
  const url=await fixture(t,{verify:async()=>({}),execute:async()=>{throw Error('wake_backend_quiescence_unverified');}});
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":1}'});
  assert.equal(res.status,503);assert.deepEqual(await res.json(),{code:'WAKE_BACKEND_QUIESCENCE_UNVERIFIED'});
});
