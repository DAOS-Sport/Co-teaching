// Isolated startup check. Synthetic local PostgreSQL only; sends no LINE/Ragic traffic.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const port = 55038;
const child = spawn(process.execPath, ['dist/index.js'], {
  env: { ...process.env, NODE_ENV:'production', PORT:String(port),
    DATABASE_URL:'postgres://isolated@127.0.0.1:55438/postgres', DATABASE_DRIVER:'pg',
    ADMIN_PASSWORD:'isolated-admin-password', TEACHER_TOKEN_SECRET:'isolated-token-secret',
    SESSION_SECRET:'isolated-session-secret', REPLIT_DOMAINS:'127.0.0.1', REPL_ID:'isolated-smoke-client',
    REPLIT_DEPLOYMENT:'', ISSUER_URL:'https://replit.com/oidc',
    ENABLE_LINE_NOTIFY:'0', ENABLE_RAGIC_SYNC:'0', ENABLE_SCHOOL_MODULE:'0',
    ENABLE_WEEKLY_PUSH_QUEUE:'0', ENABLE_WEEKLY_PUSH_WORKER:'0',
    LINE_CHANNEL_ACCESS_TOKEN:'', RAGIC_API_KEY:'', MCP_TOKEN:'',
  }, windowsHide:true, stdio:['ignore','pipe','pipe'],
});
let output='';
child.stdout.on('data', b=>{output+=b;}); child.stderr.on('data', b=>{output+=b;});
try {
  let ready=false;
  for(let i=0;i<100;i++) {
    if(child.exitCode!==null) break;
    if(output.includes(`serving on port ${port}`)) {ready=true;break;}
    await new Promise(r=>setTimeout(r,200));
  }
  assert.ok(ready, `STARTUP_FAILED\n${output}`);
  for(const [path,status] of [['/',200],['/api/venues',200],['/api/coach-portal/approved-coaches',401]]) {
    const result=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(3000)});
    assert.equal(result.status,status,path); await result.arrayBuffer();
    console.log(JSON.stringify({path,status}));
  }
  console.log('BUILT_ENTRYPOINT_PASS (school/jobs off; OIDC login not exercised)');
} finally {
  if(child.exitCode===null) {const stopped=once(child,'exit');child.kill();await stopped;}
  console.log('TASK_APP_PROCESS_STOPPED');
}
