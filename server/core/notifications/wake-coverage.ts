/** A fresh heartbeat cannot erase a prior gap. This records uncertainty, never backfills deliveries. */
export function wakeCoverageGap(input:{now:number;notBefore:number;previousCompleted:number|null;previousGap:string|null}):string|null {
  const {now,notBefore,previousCompleted,previousGap}=input;
  if(!Number.isFinite(now)||!Number.isFinite(notBefore)||(previousCompleted!==null&&!Number.isFinite(previousCompleted)))throw Error('wake_coverage_clock_invalid');
  if(previousGap)return previousGap;
  const start=Math.max(notBefore,previousCompleted??notBefore);
  return now-start>20*60_000?new Date(start).toISOString():null;
}

/** Canary proves transport only. Preserve the active clock and any known gap through mode changes. */
export function wakeCoverageReceipt(input:{now:number;notBefore:number;mode:'active'|'canary';previousCompleted:number|null;previousData?:{mode?:string;lastActiveCompleted?:string|null;gapSince?:string|null}}){
  const prior=input.previousData;
  const lastActive=prior?.lastActiveCompleted??(prior?.mode==='active'&&input.previousCompleted!==null?new Date(input.previousCompleted).toISOString():null);
  const gapSince=input.mode==='active'?wakeCoverageGap({now:input.now,notBefore:input.notBefore,previousCompleted:lastActive?Date.parse(lastActive):null,previousGap:prior?.gapSince??null}):prior?.gapSince??null;
  return {gapSince,lastActiveCompleted:input.mode==='active'?new Date(input.now).toISOString():lastActive};
}
