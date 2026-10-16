import {CanvasBridge} from '../src/canvas.ts';
import {CanvasSnapshots} from '../src/canvas-snapshots.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {ResearchTree} from '../src/research.ts';
import {AgentManager} from '../src/agents.ts';
import {MainOperations,Projects} from '../src/cli/main-operations.ts';
import {CallerAccess,serveApplication} from '../src/cli/server.ts';
import {Fault} from '../src/contracts.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import {testDeadline} from './fixtures/timing.ts';

const executable=fileURLToPath(new URL('../bin/harnessctl',import.meta.url));
/** The real executable and authenticated endpoint surround real owners. Only the
 * adjacent harness and an unavailable subsidiary read are controlled. */
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'adr025-cli-'))),configPath=join(root,'app.json');
 const config={...await loadConfig(),configPath,stateRoot:join(root,'main'),verification:false};await mkdir(config.stateRoot);await writeFile(configPath,JSON.stringify(config));
 const tree=new ResearchTree(config);await tree.initialize();const project=await tree.createProject(randomUUID(),'Overview research'),node=await tree.ensureMain(project.id),harnesses=[];
 const agents=new AgentManager(config,tree,async()=>false,(_config,_home,_workspace,_budget,permission)=>{const h=new ControlledHarness('session-'+randomUUID(),permission);harnesses.push(h);return h;});
 let projectFailure=false;
 class AvailableProjects extends Projects {get(id){if(projectFailure)throw new Fault('PROJECT_READ_FAILED','Controlled project read unavailable');return super.get(id);}}
 const projects=new AvailableProjects(tree,agents);await projects.initialize(project.id);const worker=agents.create(project.id,node,randomUUID(),{title:'Overview scientist'}).id;
 const environment={callAs(){throw new Error('Overview must not contact EnvironmentDaemon');},choices(){throw new Error('Overview must not contact EnvironmentDaemon');}};
 const snapshots=await CanvasSnapshots.open(config.stateRoot,config.canvas,error=>{throw error;});t.after(()=>snapshots.close());
 const access=new CallerAccess(config);await access.initialize();const operations=new MainOperations(config,tree,agents,projects,environment,new CanvasBridge(config.canvas),snapshots),app=await serveApplication(config,access,operations);
 t.after(async()=>{await app.close();for(const h of harnesses)h.complete();await agents.close();await tree.close();await rm(root,{recursive:true,force:true});});
 async function cli(args,overrides={}){const env={...process.env};for(const key of ['HARNESSCTL_TOKEN','HARNESSCTL_CONFIG','DSH_HARNESSCTL_TOKEN','DSH_SHELL'])delete env[key];const child=spawn(process.execPath,[executable,'--config',configPath,...args],{cwd:root,env:{...env,...overrides},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.ok(stdout.trim(),stderr);return {code,value:JSON.parse(stdout),bytes:Buffer.byteLength(stdout),stderr};}
 return {root,config,tree,project:project.id,node,agents,worker,harnesses,access,cli,setProjectFailure(value){projectFailure=value;}};
}

test('real CLI overview resolves credential identity from unrelated cwd and rejects revoked or spoofed identity', {timeout:testDeadline(30000)},async t=>{
 const f=await fixture(t),processId=randomUUID(),credential=f.access.issue(f.worker,processId);
 const missing=await f.cli(['worker','overview']);assert.equal(missing.code,3);assert.equal(missing.value.error.code,'OVERVIEW_TARGET_REQUIRED');
 const explicit=await f.cli(['worker','overview',f.worker]);assert.equal(explicit.code,0);assert.equal(explicit.value.data.worker.id,f.worker);assert.equal(explicit.value.data.placement.workspace.availability,'available');assert.ok(explicit.bytes<=f.config.workerOverviewMaxBytes);
 const selected=f.agents.create(f.project,f.node,randomUUID(),{title:'Tools assigned',environment:{environmentId:'analysis',revisionId:'v1',name:'Offline tool environment'}}).id;
 const assigned=await f.cli(['worker','overview',selected]);assert.equal(assigned.code,0);assert.equal(assigned.value.data.environment.selection.revisionId,'v1');assert.equal(assigned.value.data.environment.observation,'unknown');assert.equal(f.harnesses.length,0);
 const self=await f.cli(['worker','overview'],{HARNESSCTL_TOKEN:credential.token,DSH_SHELL:'bash',POLARITON_WORKER_ID:selected});assert.equal(self.code,0);assert.equal(self.value.data.worker.id,f.worker);assert.ok(self.value.data.coworkers.items.some(item=>item.id===selected));
 const arbitrary=await f.cli(['worker','overview',selected],{HARNESSCTL_TOKEN:credential.token});assert.equal(arbitrary.code,0);assert.equal(arbitrary.value.data.worker.id,selected);
 const spoof=await f.cli(['worker','overview','--project',f.project],{HARNESSCTL_TOKEN:credential.token});assert.equal(spoof.code,2);
 f.access.revoke(processId);const revoked=await f.cli(['worker','overview'],{HARNESSCTL_TOKEN:credential.token});assert.equal(revoked.code,4);assert.equal(revoked.value.error.code,'AUTH_REQUIRED');
});

test('real CLI overview distinguishes partial reads from successfully observed worker uncertainty', {timeout:testDeadline(30000)},async t=>{
 const f=await fixture(t);f.setProjectFailure(true);const partial=await f.cli(['worker','overview',f.worker]);assert.equal(partial.code,6);assert.equal(partial.value.data.status,'partial');assert.equal(partial.value.data.placement.project.availability,'unknown');assert.equal(partial.value.data.worker.id,f.worker);assert.equal(partial.value.data.placement.node.availability,'available');
 f.setProjectFailure(false);await f.agents.submit(f.project,f.node,f.worker,{id:randomUUID(),text:'Controlled active input'});await new Promise(resolve=>{const ready=()=>{if(f.agents.get(f.worker).state==='running'){f.agents.off('change',ready);resolve();}};f.agents.on('change',ready);ready();});f.harnesses[0].exit();
 const observed=await f.cli(['worker','overview',f.worker]);assert.equal(observed.code,0);assert.equal(observed.value.data.status,'complete');assert.equal(observed.value.data.execution.state,'uncertain');assert.ok(observed.value.data.attention.items.some(item=>item.code==='WORKER_UNCERTAIN'));
});
