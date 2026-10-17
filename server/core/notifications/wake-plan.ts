/** Trusted server clock only. No libraries, I/O, historical backfill or timers. */
export interface WakeSlot { kind:'weekly'|'daily'|'ragic'; date:string; targetDate:string; dueAt:number; key:string }
const DAY=86_400_000, OFFSET=8*3_600_000;
export function dueWakeSlots(now:number, notBefore:number): WakeSlot[] {
  if (!Number.isFinite(now)||!Number.isFinite(notBefore)||notBefore<0) throw Error('wake_clock_invalid');
  const local=new Date(now+OFFSET), date=local.toISOString().slice(0,10);
  const midnight=Date.parse(date+'T00:00:00Z')-OFFSET;
  const slots:WakeSlot[]=[];
  const add=(kind:WakeSlot['kind'],hour:number,targetDate:string)=> {
    const dueAt=midnight+hour*3_600_000;
    if(dueAt>=notBefore && dueAt<=now && now<midnight+DAY) slots.push({kind,date,targetDate,dueAt,key:`external-wake:v1:${kind}:${date}`});
  };
  add('ragic',3,date);
  if(local.getUTCDay()===0) add('weekly',12,new Date(midnight+OFFSET+DAY).toISOString().slice(0,10));
  add('daily',19,new Date(midnight+OFFSET+DAY).toISOString().slice(0,10));
  return slots;
}
