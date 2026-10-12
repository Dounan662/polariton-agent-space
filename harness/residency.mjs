// @ts-check
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import '@deepseek-ai/dsh-schedule';
import {SessionId} from '@deepseek-ai/dsh-session';
/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-jobs').default} Jobs */
/** @typedef {import('@deepseek-ai/dsh-goal').default} Goals */
/** @typedef {import('@deepseek-ai/dsh-cordis-host-runner').default} Dynamic */
/** @typedef {import('@deepseek-ai/dsh-subagent').default} Subagents */

import {ResidencySnapshot,ResidencyReserveInput,ResidencyTokenInput} from './settings.ts';

const activePluginStates=new Set(['awaiting-approval','starting-host','client-pending','running','waiting']);

/**
 * Observe and reserve one pinned Polariton DSH process, including detached wake sources.
 * This owner never cancels productive work. Native inputs are admitted through
 * admit(), so preparation cannot hide behind idle; callers serialize new ACP
 * lifecycle operations. A committed reservation fences admission until disposal
 * or explicit recovery. ACP close aborts the maintenance promise before draining
 * it; awaiting close inside that promise would deadlock.
 *
 * The proof covers Polariton's installed profile. Dynamic Cordis executions are
 * unqualified producers and keep residency; a new static producer requires its
 * own observable obligation before being added to the launch composition.
 */
/** @typedef {z.infer<typeof ResidencySnapshot>} Snapshot */
/** @typedef {{token:string,sessionId:string,revision:number,releases:Array<()=>void>,committed:boolean,timer:ReturnType<typeof setTimeout>|undefined}} Reservation */
export class Residency {
  /** @type {Reservation|undefined} */ reservation;
  /** @type {string|undefined} */ failure;
  /** @type {string[]} */ scheduled=[];
  /** @param {Context} ctx @param {{deadlineMs:number,requireSchedule:boolean,changed?:(sessionId:string,snapshot:Snapshot)=>void,schedule?:typeof setTimeout,unschedule?:typeof clearTimeout}} options */
  constructor(ctx,{deadlineMs,requireSchedule,changed=()=>{},schedule=setTimeout,unschedule=clearTimeout}) {
    if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=0)throw new Error('Residency deadline must be a positive safe integer');
    this.ctx=ctx;this.requireSchedule=requireSchedule;this.deadlineMs=deadlineMs;this.changed=changed;this.schedule=schedule;this.unschedule=unschedule;
    this.revision=0;this.subagents=new Set();this.admissions=0;this.reservation=undefined;this.notifying=false;this.closed=false;
    this.dynamicObserved=ctx.get('dynamicCordisRunner')!==undefined;
    this.scheduleObserved=ctx.get('schedule')!==undefined;this.schedulePending=false;this.scheduleEpoch=0;this.scheduled=[];
    ctx.on('schedule/changed',()=>this.refreshSchedules(),{global:true});
    if(this.scheduleObserved)this.refreshSchedules();
    const changedState=()=>this.touch();
    for(const event of /** @type {const} */(['agent/created','agent/disposed','agent/status','agent/inbox/inserted','agent/inbox/claimed','agent/inbox/discarded','session/event','goal/activation-changed','cordis/request-run','cordis/request-run-resolved','cordis/dynamic-package','cordis/dynamic-retract']))ctx.on(event,changedState,{global:true});
    ctx.on('subagent/start',info=>{this.subagents.add(info.runId);this.touch();},{global:true});
    ctx.on('subagent/end',info=>{this.subagents.delete(info.runId);this.touch();},{global:true});
    ctx.on('agent/disposed',({agent})=>{if(this.reservation&&this.reservation.sessionId===agent.id)this.release(this.reservation.token);},{global:true});
    ctx.get('jobs')?.events.subscribe({owners:'all'},event=>{if(event.type!=='output'&&event.type!=='progress')changedState();});
    ctx.effect(()=>()=>{this.closed=true;this.release(this.reservation?.token);});
  }
  /** Catalog observations are invalid until the latest post-commit notification is covered.
   * ACP has no external schedule management transport: only running agent tools can
   * create tasks. Their drivers stay busy until their mutations settle. Reserving
   * every driver and input admission therefore fences creation after an empty cut.
   * Active tasks remain blockers across original-session disposal and delayed delivery. */
  refreshSchedules() {
    this.scheduleEpoch++;this.touch();
    if(this.schedulePending||this.closed)return;
    this.schedulePending=true;
    const read=async()=>{
      try {
        do {
          const epoch=this.scheduleEpoch,service=this.ctx.get('schedule');
          if(!service)throw new Error('The qualified schedule service is unavailable');
          this.scheduleObserved=true;
          const catalog=await service.catalog();
          if(this.closed)return;
          if(epoch!==this.scheduleEpoch)continue;
          this.scheduled=catalog.filter(task=>task.status==='active').map(task=>task.id);
          break;
        }while(!this.closed);
      }catch(error){
        this.failure='Schedule activity is unknown; restart is required before suspension';
        this.ctx.logger.error('Residency schedule observation failed',error);
      }finally{
        // Clear pending in the same microtask as the final epoch check. A later
        // change must start another read, including during promise settlement.
        this.schedulePending=false;this.touch();
      }
    };
    void read();
  }

  touch() {
    this.revision++;
    if(this.notifying||this.closed)return;
    this.notifying=true;
    queueMicrotask(()=>{
      this.notifying=false;if(this.closed)return;
      for(const root of this.ctx.agents.roots())this.changed(root.id,this.inspect(root.id));
    });
  }
  /** Read owner facts synchronously; inspection neither runs a tool nor resets inactivity. */
  /** @param {string} sessionId @returns {Snapshot} */
  inspect(sessionId) {
    /** @type {Snapshot['blockers']} */
    const blockers=[];const root=this.ctx.agents.get(SessionId(sessionId)),agents=this.ctx.agents.list();
    /** @param {Snapshot['blockers'][number]['kind']} kind @param {string} [detail] */
    const add=(kind,detail)=>blockers.push({kind,...detail===undefined?{}:{detail}});
    if(!root)add('unknown','Root session is not active');
    if(this.failure)add('unknown',this.failure);
    if(this.admissions)add('admission','Message preparation or lifecycle admission is pending');
    if(this.subagents.size)add('descendant','A subagent lifecycle has not settled');
    if(this.schedulePending)add('schedule','Host reminder catalog is being observed');
    for(const id of this.scheduled)add('schedule',id);
    if((this.requireSchedule||this.scheduleObserved)&&!this.ctx.get('schedule'))add('unknown','Observed residency service is unavailable: schedule');
    try {
      const jobs=this.ctx.get('jobs'),goals=this.ctx.get('goals'),dynamic=this.ctx.get('dynamicCordisRunner');
      for(const [name,service] of [['jobs',jobs],['goals',goals]])
        if(service===undefined)add('unknown',`Required residency service is unavailable: ${name}`);
      // ACP does not install dynamic Cordis. Once a composition has exposed it,
      // disappearance cannot be interpreted as evidence that its effects settled.
      if(dynamic!==undefined)this.dynamicObserved=true;
      else if(this.dynamicObserved)add('unknown','Observed residency service is unavailable: dynamicCordisRunner');
      for(const agent of agents){
        if(agent.status==='running')add('running',agent.id);
        else if(agent.status!=='idle')add('unknown',`Unrecognized status for ${agent.id}`);
        if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length)add('inbox',agent.id);
        for(const job of jobs?.list(agent.id)??[])if(job.status==='running'||job.status==='stopping')add('job',`${agent.id}:${job.id}:${job.status}`);
        if(goals?.get(agent)?.activation==='armed')add('goal',agent.id);
      }
      for(const job of jobs?.list()??[])if(job.status==='running'||job.status==='stopping')add('job',`${job.id}:${job.status}`);
      for(const plugin of dynamic?.inventory()??[])
        if(plugin.activeRun||(plugin.latestRun!==undefined&&activePluginStates.has(plugin.latestRun.status)))add('dynamic-plugin',plugin.pluginId);
    }catch(error){add('unknown',error instanceof Error?error.message:'Activity inspection failed');}
    return {revision:this.revision,eligible:blockers.length===0,blockers,...this.reservation?{reservation:this.reservation.token}:{}};
  }
  /** Count the whole public admission promise, including asynchronous image preparation. */
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  async admit(operation) {
    if(this.reservation)throw Object.assign(new Error('Worker is unloading'),{code:'WORKER_UNLOADING'});
    this.admissions++;this.touch();
    try{return await operation();}finally{this.admissions--;this.touch();}
  }
  /** Claim every live driver without yielding, then verify the same authoritative cut. */
  /** @param {string} sessionId @param {number} revision */
  reserve(sessionId,revision) {
    const snapshot=this.inspect(sessionId);
    if(this.reservation||!snapshot.eligible||snapshot.revision!==revision)return {reserved:false,snapshot};
    /** @type {Reservation} */
    const reservation={token:randomUUID(),sessionId,revision,releases:[],committed:false,timer:undefined};
    this.reservation=reservation;
    try{
      for(const agent of this.ctx.agents.list()){
        const gate=/** @type {PromiseWithResolvers<void>} */(Promise.withResolvers());reservation.releases.push(gate.resolve);
        const task=agent.runMaintenance(signal=>{
          const abort=()=>gate.resolve();signal.addEventListener('abort',abort,{once:true});
          return gate.promise.finally(()=>signal.removeEventListener('abort',abort));
        });
        // Unexpected driver failure invalidates this observer's proof until restart.
        // A committed close keeps admission fenced for Main's cleanup owner.
        void task.catch(error=>{
          this.failure='A driver reservation failed; execution quiescence is unknown';
          this.ctx.logger.error('Residency reservation failed',error);
          if(this.reservation===reservation&&!reservation.committed)this.release(reservation.token);
          this.touch();
        });
      }
    }catch(error){
      this.release(reservation.token);
      return {reserved:false,snapshot:{...this.inspect(sessionId),eligible:false,blockers:[{kind:'maintenance',detail:error instanceof Error?error.message:'Driver reservation failed'}]}};
    }
    reservation.timer=this.schedule(()=>{
      if(this.reservation!==reservation||reservation.committed)return;
      this.ctx.logger.warn('Uncommitted idle-unload reservation expired');this.release(reservation.token);this.touch();
    },this.deadlineMs);
    reservation.timer?.unref?.();
    return {reserved:true,token:reservation.token,snapshot:this.inspect(sessionId)};
  }
  /** Revalidate before the caller sends ACP close; its own lifecycle deadline now owns settlement. */
  /** @param {string} sessionId @param {string} token */
  commit(sessionId,token) {
    const reservation=this.reservation,snapshot=this.inspect(sessionId);
    if(!reservation||reservation.token!==token||reservation.sessionId!==sessionId||!snapshot.eligible||snapshot.revision!==reservation.revision){
      if(reservation&&reservation.token===token&&!reservation.committed)this.release(token);
      return {committed:false,snapshot:this.inspect(sessionId)};
    }
    reservation.committed=true;this.unschedule(reservation.timer);
    return {committed:true,snapshot};
  }
  /** Abandon a reservation without cancelling queued or running work. */
  /** @param {string|undefined} token */
  release(token) {
    const reservation=this.reservation;
    if(!reservation||reservation.token!==token)return false;
    this.reservation=undefined;this.unschedule(reservation.timer);
    for(const release of reservation.releases)release();
    this.touch();
    return true;
  }
}
