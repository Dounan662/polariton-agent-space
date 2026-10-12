import {testDeadline} from './timing.ts';
import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {loadConfig} from '../../src/config.ts';
import {Harness} from '../../harness/client.ts';
import {AgentManager} from '../../src/agents.ts';
import {ResearchTree} from '../../src/research.ts';

/** Disposable supervisor for genuine SIGKILL qualification. No prompt reaches a
 * real model: the inherited environment has no provider key and admission denies.
 * The parent owns the fake environment peer, so its grant survives this process.
 */
const [mode,stateRoot]=process.argv.slice(2);
const config={...await loadConfig(),stateRoot,verification:true,startupTimeoutMs:testDeadline(15000),requestTimeoutMs:testDeadline(15000),shutdownTimeoutMs:testDeadline(5000)};
await mkdir(stateRoot,{recursive:true});
const send=value=>new Promise((resolve,reject)=>process.send(value,error=>error?reject(error):resolve()));
let attemptedRequests=0;
const deny=async()=>{attemptedRequests++;await send({kind:'provider-attempt'});return false;};
process.on('message',()=>{}); // Retain a supervisor lifetime until the test kills it.
try {
  if(mode==='dsh'){
    const workspace=join(stateRoot,'workspace'),home=join(stateRoot,'harness');await mkdir(workspace);
    const harness=new Harness(config,home,workspace,deny);
    harness.on('transportError',error=>{void send({kind:'transport-error',message:error.message});});
    await harness.start();
    const opened=await harness.activate(null,[]);
    await harness.observe(opened.sessionId);
    const processes=execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8',timeout:config.requestTimeoutMs,maxBuffer:config.maxFrameBytes}).split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
    const guardian=processes.find(record=>Number(record[2])===process.pid&&record[3].includes('/harness/guardian.mjs'));
    const child=guardian&&processes.find(record=>Number(record[2])===Number(guardian[1])&&record[3].includes('/dsh/lib/bin.js'));
    if(!child)throw new Error('Owned DSH process not found');
    await send({kind:'ready',pid:process.pid,dshPid:Number(child[1]),guardianPid:Number(guardian[1]),guardian:harness.recoveryIdentity,sessionId:opened.sessionId,attemptedRequests});
  } else if(mode==='activation'){
    const tree=new ResearchTree(config);await tree.initialize();
    const project=await tree.createProject(randomUUID(),'Abrupt activation recovery'),node=await tree.ensureMain(project.id);
    const environment={environmentId:'crash-environment',revisionId:'r1',name:'Crash fixture'};
    let identity;
    const access={
      async choices(){return [{environment,observedAt:'2026-09-24T00:00:00Z'}];},
      async acquire(input){
        const response=new Promise(resolve=>{const receive=value=>{if(value.kind==='grant-response'&&value.id===input.id){process.off('message',receive);resolve(value.grant);}};process.on('message',receive);});
        await send({kind:'acquire',input});return response;
      },
      async release(input){await send({kind:'unexpected-release',input});},
    };
    class OpeningHarness extends EventEmitter {
      async start(){await send({kind:'ready',pid:process.pid,...identity,attemptedRequests});return new Promise(()=>{});}
      async close(){}
    }
    const agents=new AgentManager(config,tree,deny,()=>new OpeningHarness(),{environment:access,catalog:{async choices(){return [];}}});
    const worker=agents.create(project.id,node,randomUUID(), {title:'Interrupted setup'}),submissionId=randomUUID();
    identity={project:project.id,node,workerId:worker.id,submissionId};
    await agents.selectEnvironment(project.id,node,worker.id,environment);
    await agents.submit(project.id,node,worker.id,{id:submissionId,text:'Do not replay this interrupted first message automatically'});
  } else throw new Error('Unknown crash qualification mode');
} catch(error){await send({kind:'failure',message:error instanceof Error?error.stack:String(error)});process.exitCode=1;process.disconnect();}
