export interface BoundedJob {id:string;name:string;data:any;[key:string]:any}
export interface JobStep {complete:boolean;data?:unknown;retryAt?:Date}
/** No detached promises: the handler and durable acknowledgement settle before another claim. */
export async function drainBoundedJobs(deps:{
  fetch():Promise<BoundedJob|null>;
  handle(job:BoundedJob):Promise<JobStep>;
  acknowledge(job:BoundedJob,result:JobStep):Promise<void>;
},control:{maxJobs:number;shouldContinue():boolean}) {
  if(!Number.isInteger(control.maxJobs)||control.maxJobs<1||control.maxJobs>400)throw Error('wake_batch_invalid');
  let processed=0;
  while(processed<control.maxJobs && control.shouldContinue()) {
    const job=await deps.fetch(); if(!job)break;
    const result=await deps.handle(job);
    await deps.acknowledge(job,result);
    processed++;
  }
  return {processed};
}
