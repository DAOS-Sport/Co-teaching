import type { Express, RequestHandler } from 'express';
import { GithubWakeIdentityError, parseGithubWakeIdentityConfig, verifyGithubWakeIdentity } from '../../infra/auth/githubWakeIdentity';
import { runInOperationScope } from '../../shared/http/operationScope';

/** Authentication imports have no operational DB/queue imports. Runtime is loaded only after verification. */
export function notificationWakeHandler(deps:{verify?:typeof verifyGithubWakeIdentity;execute?:()=>Promise<unknown>}={}):RequestHandler {
  return async(req,res)=>{
    try {
      const config=parseGithubWakeIdentityConfig(process.env);
      if(!config.enabled)return res.status(503).json({version:1,status:'disabled',remainingWork:false,processed:0,failed:0});
      await (deps.verify??verifyGithubWakeIdentity)(req.headers.authorization,config);
      if(!req.body||Array.isArray(req.body)||req.body.version!==1||Object.keys(req.body).length!==1)return res.status(400).json({code:'WAKE_BODY_INVALID'});
      const ctrl=new AbortController(),deadlineMs=Date.now()+20_000;
      const abort=()=>ctrl.abort();
      req.once('aborted',abort);
      const close=()=>{if(!res.writableEnded)abort();};res.once('close',close);
      if(req.aborted||res.destroyed||res.writableEnded)abort();
      const timer=setTimeout(abort,16_500);
      try {
        if(ctrl.signal.aborted)return;
        const result:any=await runInOperationScope({signal:ctrl.signal,deadlineMs,abort},async()=>
          deps.execute?deps.execute():(await import('./wake-runtime')).executeNotificationWake());
        if(!res.destroyed)return res.status(result.status==='busy'?409:200).json(result);
      } finally {clearTimeout(timer);req.off('aborted',abort);res.off('close',close);}
    } catch(error) {
      const auth=error instanceof GithubWakeIdentityError;
      const code=auth?error.code:error instanceof Error&&error.message==='wake_backend_quiescence_unverified'?'WAKE_BACKEND_QUIESCENCE_UNVERIFIED':'WAKE_EXECUTION_INCOMPLETE';
      // Fixed codes only: auth refusals must not enqueue an unscoped app_log DB write.
      console.warn(`[notification-wake] ${code}`);
      if(!res.headersSent&&!res.destroyed)res.status(auth&&code!=='WAKE_CONFIG_INVALID'?401:503).json({code});
    }
  };
}
export function registerNotificationWakeRoutes(app:Express){app.post('/api/internal/notification-wake',notificationWakeHandler());}
