import { createRequire } from 'node:module';
import { currentOperation } from '../../shared/http/operationScope';
import { randomUUID } from 'node:crypto';
const require=createRequire(import.meta.url);
const {Client,types}=require('pg');
const {parse}=require('pg-connection-string');
/** Owns this one native session. An aborted request closes its socket, including stalled reads. */
export function boundedNativePg(connectionString:string,options:{readOnly?:boolean}={}) {
  const operation=currentOperation();
  const signal=operation?.signal;
  if(signal?.aborted)throw Error('wake_operation_stopped');
  const applicationName='ct-external-wake-v1:'+randomUUID();
  // pg reparses connectionString after options and lets URL query parameters override them.
  // Parse once, then apply the operation's non-overridable identity and timeout bounds.
  const connection=parse(connectionString);
  const startupOptions=(name:string,readOnly:boolean,timeout:number)=>`${connection.options??''} -c application_name=${name} -c default_transaction_read_only=${readOnly?'on':'off'} -c statement_timeout=${timeout} -c lock_timeout=500 -c idle_in_transaction_session_timeout=10000`;
  const client=new Client({...connection,application_name:applicationName,connectionTimeoutMillis:3000,query_timeout:3500,
    statement_timeout:3000,lock_timeout:500,idle_in_transaction_session_timeout:10000,
    // pg's Date parser discards PostgreSQL microseconds. Exact claim fencing must keep wire text.
    types:{getTypeParser:(oid:number,format:string)=>[1114,1184].includes(oid)?(value:string)=>value:types.getTypeParser(oid,format)},
    options:startupOptions(applicationName,Boolean(options.readOnly),3000)});
  let closing:Promise<void>|undefined;
  const endSocket=async(target:any)=>{const ended=target.end().catch(()=>{});target.connection.stream.destroy();await ended;};
  const cancelAndCloseOwnBackend=async()=>{
    if(!client.processID){await endSocket(client);return;}
    const cancelName='ct-wake-cancel:'+randomUUID();
    const cancel=new Client({...connection,application_name:cancelName,connectionTimeoutMillis:1000,query_timeout:750,
      statement_timeout:500,lock_timeout:500,idle_in_transaction_session_timeout:10000,options:startupOptions(cancelName,false,500)});
    cancel.on('error',()=>{});
    let gone=false;
    try {
      await cancel.connect();
      // PID plus an unguessable per-session name and current DB/role fence this to our own query.
      const cancelled=await cancel.query("SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND usename=current_user AND datname=current_database()",[client.processID,applicationName]);
      await endSocket(client);
      if(cancelled.rows.length>0&&cancelled.rows[0].cancelled!==true)throw Error('cancel_refused');
      const deadline=Date.now()+900;
      do {
        const remaining=deadline-Date.now();if(remaining<=0)break;
        const result=await cancel.query({text:"SELECT pid FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND usename=current_user AND datname=current_database()",values:[client.processID,applicationName],query_timeout:Math.min(750,remaining)});
        if(result.rows.length===0){gone=true;break;}
        const pause=Math.min(25,deadline-Date.now());if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));
      }while(Date.now()<deadline);
    }catch { /* A local socket close alone cannot prove server query/transaction/lock exit. */ }
    finally {await endSocket(client);await endSocket(cancel);}
    if(!gone)throw Error('wake_backend_quiescence_unverified');
  };
  const close=(cancelQuery=false)=> {
    if(!closing) {
      closing=cancelQuery?cancelAndCloseOwnBackend():endSocket(client);
    }
    return closing;
  };
  const abort=()=>{void close(true).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  client.on('error',()=>{operation?.abort?.();void close(true).catch(()=>{});});
  const query=client.query.bind(client);
  client.query=(...args:any[])=>{
    if(signal?.aborted)return Promise.reject(Error('wake_operation_stopped'));
    return query(...args).catch((error:any)=> {
    if(error?.message==='Query read timeout'||['ECONNRESET','ETIMEDOUT','EPIPE','57P01'].includes(error?.code)) {
      operation?.abort?.();void close(true).catch(()=>{});
    }
    throw error;
  });};
  return {client,async dispose(){signal?.removeEventListener('abort',abort);await close();}};
}
