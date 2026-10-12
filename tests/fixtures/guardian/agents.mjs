import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {loadConfig} from '../../../src/config.ts';
import {AgentManager} from '../../../src/agents.ts';
import {ResearchTree} from '../../../src/research.ts';
import {guardianIdentity,settleGuardian} from '../../../harness/guardian-control.mjs';

const [stateRoot]=process.argv.slice(2),config={...await loadConfig(),stateRoot,maxActiveWorkers:2};
const tree=new ResearchTree(config);await tree.initialize();
let guardianPid;
class FixtureHarness extends EventEmitter {
  constructor(home){super();this.recoveryIdentity=guardianIdentity(home);this.sessionId=randomUUID();}
  async start(){
    this.child=spawn(process.execPath,[fileURLToPath(new URL('../../../harness/guardian.mjs',import.meta.url))],{detached:true,stdio:['pipe','pipe','pipe','pipe','ipc']});
    guardianPid=this.child.pid;
    process.send?.({guardianPid});
    this.child.stdout.resume();this.child.stderr.pipe(process.stderr);this.child.stdio[3].resume();
    const started=new Promise((accept,reject)=>{this.child.on('message',m=>{if(m.type==='started')accept();});this.child.on('error',reject);this.child.once('exit',(code,signal)=>reject(new Error(`Fixture guardian exited before readiness (${signal??code})`)));});
    this.child.send({identity:this.recoveryIdentity,execution:'native',command:process.execPath,args:[fileURLToPath(new URL('./tree.mjs',import.meta.url)),join(stateRoot,'pids.jsonl'),'2','yes','native'],cwd:stateRoot,env:process.env,limits:{...config.guardian,maxFrameBytes:config.maxFrameBytes}});
    await started;return {image:false};
  }
  async locate(){return null;}
  async activate(){return {sessionId:this.sessionId,mcp:[],options:[{id:'model',name:'Model',currentValue:JSON.stringify([config.provider,config.model]),options:[{value:JSON.stringify([config.provider,config.model]),name:config.model}]}]};}
  async message(sessionId,requestId,content){
    this.emit('source',{sessionId,seq:0,type:'user/message',event:{type:'user/message',seq:0,time:1000,data:{source:{kind:'user',rpcId:requestId},content}}});
    this.emit('submission',{sessionId,requestId,state:'applied'});return {messageId:requestId};
  }
  async closeSession(){}
  async activity(){return {revision:0,eligible:false,blockers:[{kind:'unknown'}]};}
  async close(){await settleGuardian(this.recoveryIdentity,{...config.guardian,maxFrameBytes:config.maxFrameBytes},'native');}
}
const agents=new AgentManager(config,tree,async()=>false,(_config,home)=>new FixtureHarness(home),{catalog:{async choices(){return [];}}});
const project=await tree.createProject(randomUUID(),'Guardian restart'),node=await tree.ensureMain(project.id),worker=agents.create(project.id,node,randomUUID(), {title:'Crash worker'});
await agents.submit(project.id,node,worker.id,{id:randomUUID(),text:'fixture'});
await new Promise(accept=>{const check=()=>{if(agents.list(project.id,node).find(w=>w.id===worker.id)?.submissions[0]?.state==='applied'){agents.off('change',check);accept();}};agents.on('change',check);check();});
process.send({project:project.id,node,workerId:worker.id,guardianPid});
process.on('message',()=>{});
