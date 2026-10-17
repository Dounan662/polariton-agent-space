/** Synthetic native-presentation qualification with isolated sentinel credentials; no model requests. */
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {Context} from '@deepseek-ai/cordis';
import {Session,SessionId,SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';
import {createUserMessage,createAssistantMessage,createToolResultMessage} from '@deepseek-ai/dsh-llm';
import {CompactionId,compactCheckpointSource} from '@deepseek-ai/dsh-compaction';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {Config,sourceRoot} from '../src/config.ts';
import {testConfig} from '../tests/fixtures/config.ts';
import {configureTestProviders} from '../tests/fixtures/providers.ts';
import {ControlledHarness} from '../tests/fixtures/harness.ts';
import {activateWorker} from '../tests/fixtures/activation.ts';
import {createApp} from '../src/main.ts';
const {values}=parseArgs({options:{campaign:{type:'string',default:'adr006'},port:{type:'string',default:'4326'},smoke:{type:'boolean',default:false}}});
const campaign=values.campaign;
if(!['adr006','adr007'].includes(campaign))throw new Error('Unknown verification campaign');
const directory=join(sourceRoot,'.local',campaign);await mkdir(directory,{recursive:true});
const stateRoot=await mkdtemp(join(directory,'presentation-'));
// The isolated fixture owns its application socket, peer configuration and saved
// provider setup. The reusable fake is the sole execution adapter, including UI input.
const config=Config.parse({...await testConfig(stateRoot),port:Number(values.port),provider:'deepseek-official',model:'deepseek-flash',verification:false});
await configureTestProviders(config);
const harnessSessionId=SessionId('native-presentation');
let launches=0;
const runtime=await createApp(config,(_settings,_home,_workspace,_budget,permission)=>{
 launches++;return new ControlledHarness(harnessSessionId,permission,config.model);
});
let serving=false;
try {
const project=await runtime.tree.createProject(globalThis.crypto.randomUUID(), `${campaign.toUpperCase()} presentation qualification`),node=randomUUID(),worker=randomUUID();
await runtime.tree.mutate(project.id,{operationId:randomUUID(),revision:0,command:{kind:'node.create',id:node,title:'Native presentation',description:'Synthetic source; no model request'}});
runtime.agents.create(project.id,node,worker,{title:'Native trajectory and math'});
await activateWorker(runtime.agents,project.id,node,worker);
await runtime.agents.closeWorker(project.id,node,worker);
const home=join(stateRoot,'harness',worker),ctx=new Context();
try {
await ctx.plugin(LocalAttachmentStore,{dshHome:home});
const [image]=await ctx.attachments.saveImages([{data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC','base64'),mediaType:'image/png',name:'fixture.png'}]);
await ctx.plugin(JsonlSessionPersistence,{root:join(home,'sessions')});
const source=Session.create(harnessSessionId,undefined,{version:SESSION_FORMAT_VERSION,id:harnessSessionId,createdAt:1000,isSeeded:false,cwd:runtime.tree.workspace(project.id,node)});
source.append('turn/start',{turn:1});source.append('user/message',createUserMessage({content:[{type:'text',text:'Inspect math, code, and the retained image.'},{type:'image',attachment:image}],source:{kind:'user'}}),{surfaceOp:'append'});
source.append('step/start',{turn:1,step:1});
source.append('request/header',{reason:'initial',header:{config:{provider:'synthetic-qualification',model:'no-model'}}});
source.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'Equation: $E=mc^2$.\n\n$$\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}$$\n\n```python\nprint("native renderer")\n```\n\n| Case | Result |\n|---|---|\n| Math | rendered |\n\n[Reference](https://example.com) and escaped \\*literal\\*.'},{type:'tool-call',id:'fixture-tool',name:'read',arguments:JSON.stringify({path:'notes.md'})}],source:{kind:'model',provider:'synthetic-qualification',model:'no-model'}}),stream:[],usage:{inputTokens:10,outputTokens:20,totalTokens:30,cacheReadTokens:5}}, {surfaceOp:'append'});
source.append('tool/call',{turn:1,step:1,callId:'fixture-tool',name:'read',arguments:JSON.stringify({path:'notes.md'})});
source.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:'fixture-tool',isError:false,content:[{type:'text',text:'# Workspace preview\n\n$E=mc^2$'}]})},{surfaceOp:'append'});
source.append('step/end',{turn:1,step:1});
const compactionId=CompactionId('native-compaction');
const compactStart=source.append('compaction/start',{compactionId,turn:1});
const compactSummary=source.append('compaction/summary',{compactionId,summary:[{type:'text',text:'Preserved math, image and tool evidence.'}],shadowedRange:{start:1,end:1},shadowedSeqs:[1],shadowedTokenCount:10,provider:'synthetic-qualification',model:'no-model'});
source.append('user/message',createUserMessage({content:[{type:'text',text:'Preserved math, image and tool evidence.'}],source:compactCheckpointSource(compactionId)}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[compactStart.seq,compactSummary.seq,1]});
source.append('compaction/end',{compactionId,turn:1});
source.append('turn/end',{turn:1,reason:{kind:'completed'}});
const writer=await ctx.sessionPersistence.create(source.header);await writer.append(source.snapshotEvents());await writer.flush();await writer.close();
} finally {await ctx.fiber.dispose();}
await writeFile(join(runtime.tree.workspace(project.id,node),'notes.md'),`# Renderer boundary fixture\n\nInline $E=mc^2$ and display:\n\n$$\\frac{1}{2}$$\n\n<img src=x onerror="alert(1)">\n\n[Unsafe](javascript:alert(1))\n\nMalformed $\\notacommand{x}$ remains inspectable.\n\n\`\`\`python\nprint("unfinished fence")\n`);
// Smoke through the production read boundary after execution has closed. Opening
// trajectory and retained media must not construct another execution adapter.
const page=await runtime.agents.history(project.id,node,worker);
assert.equal(page.formatVersion,SESSION_FORMAT_VERSION);
assert.ok(page.events.some(event=>event.type==='compaction/end'));
assert.ok(page.events.some(event=>event.type==='tool/result'));
const retained=page.attachments[0];assert.ok(retained);
const media=await runtime.agents.evidence(project.id,node,worker,retained.reference);
assert.equal(media.mediaType,'image/png');assert.ok(media.bytes.length);
assert.equal(launches,1);
await writeFile(join(directory,'presentation-state.json'),JSON.stringify({stateRoot,project:project.id,node,worker}));
if(values.smoke){
 console.log('Synthetic presentation: admission, cold history, compaction, tool result and retained image passed; no model requests.');
}else{
 await runtime.app.listen({host:'127.0.0.1',port:config.port});serving=true;
 console.log(runtime.launchUrl);
 process.once('SIGINT',()=>void runtime.app.close());process.once('SIGTERM',()=>void runtime.app.close());
}
} finally {if(!serving)await runtime.app.close();}
