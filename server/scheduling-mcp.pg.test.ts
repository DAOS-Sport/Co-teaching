import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
const target=process.env.AUDIT_PG_URL;
if(!target||process.env.CT_THROWAWAY_PG!=="1"||new URL(target).hostname!=="127.0.0.1"||!/^\/ct_ca3_[a-z0-9_]+$/.test(new URL(target).pathname)||!new URL(target).port||new URL(target).port==="5432")throw Error("Explicit isolated PostgreSQL target required");
process.env.DATABASE_URL=target;
process.env.ADMIN_PASSWORD="synthetic-ca3-admin";
process.env.GROK_SCHEDULING_TOKEN="synthetic-ca3-scheduling-fixture-token-0000000000";
test("actual Streamable HTTP MCP preserves shared version errors and atomic writes",{timeout:30000},async()=>{
 const pg=(await import("pg")).default,{drizzle}=await import("drizzle-orm/node-postgres"),schema=await import("@shared/schema"),ctx=await import("./shared/dbContext");
 const {registerSchedulingMcpRoutes}=await import("./mcp/schedulingMcp.routes"),{SCHEDULING_MCP_PATH}=await import("./mcp/schedulingOAuth");
 const express=(await import("express")).default,pool=new pg.Pool({connectionString:target}),db=drizzle(pool,{schema});ctx.setBaseDbForTest(db);
 const app=express();app.use(express.json());registerSchedulingMcpRoutes(app);const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}${SCHEDULING_MCP_PATH}`;let id=0;
 const rpc=async(method:string,params?:unknown,authorized=true)=>{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",...(authorized?{authorization:`Bearer ${process.env.GROK_SCHEDULING_TOKEN}`}:{})},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,...(params?{params}:{})})});return {status:response.status,body:await response.json() as any};};
 const call=async(args:unknown)=>{const r=await rpc("tools/call",{name:"update_schedule",arguments:args});assert.equal(r.status,200);assert.ok(r.body.result?.content);return {isError:!!r.body.result.isError,value:JSON.parse(r.body.result.content[0].text)};};
 try{
  await db.insert(schema.venues).values({id:"mcp-wire-venue",name:"Synthetic MCP Venue",color:"blue",order:90});await db.insert(schema.timeSlots).values({id:"mcp-wire-slot",period:"9",startTime:"12:00",endTime:"13:00",order:9});
  await db.insert(schema.schedules).values({id:"mcp-wire-row",date:"2099-09-01",venueId:"mcp-wire-venue",timeSlotId:"mcp-wire-slot",className:"Synthetic MCP Class"});
  const before=Number((await pool.query("select count(*)::int as n from operation_audit")).rows[0].n);
  assert.equal((await rpc("tools/list",undefined,false)).status,401);
  assert.equal((await rpc("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"synthetic-ca3",version:"1"}})).status,200);
  assert.ok((await rpc("tools/list")).body.result.tools.some((t:any)=>t.name==="update_schedule"));
  let result=await call({scheduleId:"mcp-wire-row",notes:"missing version"});assert.equal(result.isError,true);assert.equal(result.value.code,"VERSION_REQUIRED");
  result=await call({scheduleId:"mcp-wire-row",expectedVersion:1,notes:"actual MCP saved"});assert.equal(result.isError,false);assert.equal(result.value.updated.version,2);
  result=await call({scheduleId:"mcp-wire-row",expectedVersion:1,notes:"stale version"});assert.equal(result.isError,true);assert.equal(result.value.code,"VERSION_CONFLICT");
  assert.deepEqual((await pool.query("select notes,version from schedules where id='mcp-wire-row'")).rows,[{notes:"actual MCP saved",version:2}]);
  assert.equal(Number((await pool.query("select count(*)::int as n from operation_audit")).rows[0].n)-before,1);
 }finally{ctx.setBaseDbForTest(null);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
});
