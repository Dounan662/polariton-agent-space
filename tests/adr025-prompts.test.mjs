import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt,{renderPrompt,renderContextSnapshot} from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm,{LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import Goals from '@deepseek-ai/dsh-goal';
import Jobs from '@deepseek-ai/dsh-jobs-local';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent';
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs';
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal';
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow';
import Workflow from '@deepseek-ai/dsh-workflow';
import Plan from '@deepseek-ai/dsh-plan-mode';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import Approval from '@deepseek-ai/dsh-user-approval';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import * as ToolSearch from '@deepseek-ai/dsh-tool-fs-search';
import * as ToolBash from '@deepseek-ai/dsh-tool-bash';
import Shell from '@deepseek-ai/dsh-shell';
import Subprocess from '@deepseek-ai/dsh-subprocess';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import {loadPolaritonPrompt,promptPolicy} from '../harness/prompt.ts';
import {compose} from '../harness/composition.ts';
import {loadConfig} from '../src/config.ts';
import * as Instructions from '../harness/instructions.mjs';

// Read the pinned deployment's plan text; never maintain a Polariton copy of it.
const base=await readFile(new URL('../node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',import.meta.url),'utf8');
const plan=base.match(/    - id: plan-mode\n[\s\S]*?        section: \|\n([\s\S]*?)(?=    - id:)/)[1].split('\n').map(line=>line.replace(/^ {14}/,'')).join('\n').trimEnd();

/** Compare actual upstream contributions at their public assembly boundary. */
async function native(t,{polariton=false,tools=true}={}){
 const ctx=new Context(),handles=[],workspace=process.cwd();
 const storage=await mkdtemp(join(tmpdir(),'polariton-prompt-sessions-'));
 t.after(async()=>{for(const handle of handles)await handle.dispose();await ctx.fiber.dispose();await rm(storage,{recursive:true,force:true});});
 const patches=await compose({...await loadConfig(),verification:true,workerIdentity:{workerId:'worker-fixture',nodeId:'node-fixture',projectId:'project-fixture'},workerInstructions:'Literal {{worker-specialization}}'},'/workspace/{{literal}}');
 const config=patches.find(row=>row.id==='system-prompt').config;
 await ctx.plugin(SystemPrompt,polariton?config:{});
 for(const plugin of [Tools,Agents,Sessions,Projections,Llm,AgentLoop,Goals,Jobs,FileSystem,WorkingDirectory,Subagents,Spawn,Workflow])await ctx.plugin(plugin,{});
 await ctx.plugin(Persistence,{root:storage});
 await ctx.plugin(Plan,{section:plan});
 await ctx.plugin(SandboxPolicy,{mode:'workspace-write',workspaceRoot:workspace});
 await ctx.plugin(Approval,{policy:'ask'});
 if(tools){await ctx.plugin(Subprocess,{});await ctx.plugin(Shell,{});await ctx.plugin(ShellEnv,{dshHome:'/fixture-home'});await ctx.plugin(ToolFs,{});await ctx.plugin(ToolSearch,{sampleOverCapGlobResults:false});await ctx.plugin(ToolBash,{});await ctx.plugin(ToolGoal,{});await ctx.plugin(ToolJobs,{waitTimeoutMs:30000,maxWaitTimeoutMs:600000,maxConsecutiveWakes:3});await ctx.plugin(ToolSubagent,{provider:'spawn'});await ctx.plugin(ToolWorkflow,{});}
 if(polariton){const extra=patches.flatMap(row=>row.insert??[]).find(row=>row.id==='polariton-worker-instructions');await ctx.plugin(Instructions,extra.config);}
 const handle=await ctx.agents.create({sessionId:'same-session',meta:{cwd:workspace},agentOptions:{provider:'controlled',model:'local'}});handles.push(handle);
 return {ctx,agent:handle.agent,config,workspace};
}
for(const tools of [true,false])test(`Polariton leaves native sections, tools and runtime policies unchanged with native tools ${tools?'available':'unavailable'}`,async t=>{
 const baseline=await native(t,{tools}),polariton=await native(t,{polariton:true,tools});
 for(const active of [false,true]){
  for(const f of [baseline,polariton])f.ctx.planMode.set(f.agent,active);
  const original=await baseline.ctx.systemPrompt.assemble({agent:baseline.agent,scope:baseline.agent});
  const actual=await polariton.ctx.systemPrompt.assemble({agent:polariton.agent,scope:polariton.agent});
  const nativeSections=assembly=>assembly.sections.filter(section=>!['harness:identity','deployment:persona-prefix','deployment:persona-suffix','polariton:placement','polariton:worker-instructions'].includes(section.name));
  assert.deepEqual(nativeSections(actual),nativeSections(original));
  assert.deepEqual(actual.tools,original.tools);assert.deepEqual(actual.contexts,original.contexts);
  assert.equal(actual.sections.find(section=>section.name==='plan:policy').text,active?plan:'');
  assert.match(renderContextSnapshot(actual),/Approval policy: ask/);
  assert.match(renderContextSnapshot(actual),/workspace-write/);
  if(tools)for(const name of ['tool:goal','tool:jobs','tool:subagent','tool:workflow','tool:bash','tool:read','tool:edit','tool:write','tool:glob','tool:grep'])assert(actual.sections.some(section=>section.name===name&&section.text.length),name);
  const text=renderPrompt(actual);assert.equal(text.split('You are a Polariton worker,').length-1,1);
  assert(!text.includes('You are an AI agent powered by DeepSeek Harness.'));assert(!text.includes('DeepSeek Harness Web GUI'));
  assert(!text.includes('designated worker'));assert(!text.includes('Name and Role'));
  const placement=actual.sections.find(section=>section.name==='polariton:placement').text;
  const identity=JSON.parse(placement.slice(placement.indexOf('{')));
  assert.deepEqual(identity,{workerId:'worker-fixture',nodeId:'node-fixture',projectId:'project-fixture',workspace:'/workspace/{{literal}}'});
  assert(text.includes('harnessctl worker overview'));assert(text.includes('/workspace/{{literal}}'));assert(text.includes('Literal {{worker-specialization}}'));
  assert(text.includes('capability page in Environment → Capabilities'));assert(text.includes('separate connection per protected resource'));assert(text.includes('Registration does not establish authentication or tool readiness'));
 }
});

test('required prompt resource fails on missing, malformed, incomplete or oversized content without skill fallback',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'polariton-prompt-resource-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=pathToFileURL(join(dir,'prompt.json')),valid=JSON.parse(await readFile(new URL('../harness/polariton-prompt.json',import.meta.url),'utf8'));
 await assert.rejects(loadPolaritonPrompt(path),{code:'ENOENT'});
 for(const value of ['{',JSON.stringify({...valid,about:''}),JSON.stringify({...valid,cli:'{{unknown}}'}),JSON.stringify({...valid,about:'word '.repeat(promptPolicy.maxSharedWords+1)}),Buffer.from([0xff])]){
  await writeFile(path,value);await assert.rejects(loadPolaritonPrompt(path));
 }
 const prompt=await loadPolaritonPrompt();assert(prompt.words<=promptPolicy.maxSharedWords);assert(prompt.bytes>0);t.diagnostic(`Shared Polariton prompt: ${prompt.words} words, ${prompt.bytes} UTF-8 bytes`);
});

test('native child retains Polariton launch placement and same credential grant without acquiring a new worker identity',{timeout:5000},async t=>{
 const f=await native(t,{polariton:true});
 const token='controlled-private-fixture';
 // Match the bridge's global application grant; native shell collection supplies
 // each execution's own session ID independently of the application credential.
 f.ctx.shellEnv.register({name:'harnessctl',variables:{DSH_HARNESSCTL_TOKEN:{description:'Test private grant'}},resolve:()=>({DSH_HARNESSCTL_TOKEN:token})});
 let child,assembly,environment;
 class Adapter extends LlmAdapter{
  async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']};}
  async *stream(){yield {type:'finish',reason:{kind:'stop'}};}
 }
 f.ctx.llm.registerAdapter(['controlled'],new Adapter());
 f.ctx.on('agent/created',async({agent})=>{if(agent===f.agent)return;child=agent;assembly=await agent.ctx.systemPrompt.assemble({agent,scope:agent});environment=f.ctx.shellEnv.collect({agent});},{global:true});
 const result=await f.ctx.tools.execute({callId:'child',name:'subagent',arguments:{description:'Controlled inheritance check',prompt:'Finish'},agent:f.agent,signal:new AbortController().signal});
 assert.equal(result.isError,false,JSON.stringify(result));assert(child);assert.notEqual(child.id,f.agent.id);
 assert.equal(child.session.header.parentSession,f.agent.id);assert.equal(child.session.header.cwd,f.workspace);
 assert.equal(environment.DSH_SESSION_ID,child.id);assert.equal(environment.DSH_HARNESSCTL_TOKEN,token);
 const text=renderPrompt(assembly);assert(text.includes('worker-fixture'));assert(!text.includes(token));
 assert.match(renderContextSnapshot(assembly),/delegated subagent/);
 assert.match(renderContextSnapshot(assembly),/Approval prompts are disabled/);
});

for(const kind of ['user','polariton-worker'])test(`unchanged native goal tool ${kind==='user'?'accepts human':'rejects worker'} authority inside a real driver turn`,{timeout:5000},async t=>{
 const f=await native(t,{polariton:true});let result;
 class Adapter extends LlmAdapter{
  async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']};}
  async *stream(request){
   result=await f.ctx.tools.execute({callId:'authority-check',name:'create_goal',arguments:{objective:'A controlled goal'},agent:f.agent,signal:request.signal});
   yield {type:'finish',reason:{kind:'stop'}};
  }
 }
 f.ctx.llm.registerAdapter(['controlled'],new Adapter());
 const source=kind==='user'?{kind,rpcId:'human-request'}:{kind,workerId:'colleague',rpcId:'worker-request'};
 f.agent.steer(createUserMessage({content:[{type:'text',text:'Create a goal for this task.'}],source}));
 await f.agent.whenIdle();assert(result);
 if(kind==='user'){assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.ctx.goals.get(f.agent).objective,'A controlled goal');}
 else {assert.equal(result.isError,true);assert.match(result.error.message,/requires a direct human turn/);assert.equal(f.ctx.goals.get(f.agent),undefined);}
});
