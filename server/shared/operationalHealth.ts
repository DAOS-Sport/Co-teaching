type Service={enabled:boolean;status:string};
export function operationalHealth(services:Service[],auditStatus:string,logStatus:string,writer:{failed:number;dropped:number;consoleFailed?:number;rejected?:number;stopped?:boolean}|null) {
  const active=services.filter(s=>s.enabled);
  if(writer?.consoleFailed)
    return {status:'degraded' as const,reason:'console 日誌輸出失敗；持久事件狀態已分開記錄，不能視為完整紀錄。'};
  if(active.some(s=>['error','timeout','misconfigured'].includes(s.status))||auditStatus==='error'||logStatus==='error'||(writer&&(writer.failed>0||writer.dropped>0||(writer.rejected??0)>0||writer.stopped===true)))
    return {status:'degraded' as const,reason:'已檢查服務有異常，或操作／錯誤紀錄不完整。'};
  if(active.some(s=>s.status!=='ok')||auditStatus!=='ready'||logStatus!=='ready'||!writer)
    return {status:'unknown' as const,reason:'部分啟用服務尚未實查，或持久紀錄尚未接通。'};
  return {status:'ok' as const,reason:'本次已檢查的啟用服務與紀錄管道正常；容量與外部送達另行驗證。'};
}
