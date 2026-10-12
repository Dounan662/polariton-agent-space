/** Synthetic native-presentation qualification; never loads a provider or credentials. */
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Context} from '@deepseek-ai/cordis';
import {Session,SessionId,SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';
import {createUserMessage,createAssistantMessage,createToolResultMessage} from '@deepseek-ai/dsh-llm';
import {CompactionId,compactCheckpointSource} from '@deepseek-ai/dsh-compaction';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {loadConfig,sourceRoot} from '../src/config.ts';
import {createApp} from '../src/main.ts';
const campaign=process.argv.includes('--campaign')?process.argv[process.argv.indexOf('--campaign')+1]:'adr006';
if(!['adr006','adr007'].includes(campaign))throw new Error('Unknown verification campaign');
const directory=join(sourceRoot,'.local',campaign);await mkdir(directory,{recursive:true});
const stateRoot=await mkdtemp(join(directory,'presentation-'));
const config={...await loadConfig(),stateRoot,port:4326,verification:false};
const harnessSessionId=SessionId('native-presentation');
class InspectionHarness extends EventEmitter {
 async start(){return {agentCapabilities:{promptCapabilities:{image:false}}};}
 async request(method){if(method==='session/list')return {sessions:[]};if(method==='session/new')return {sessionId:harnessSessionId};if(method==='session/close')return {};throw new Error('Synthetic inspection cannot execute');}
 async close(){this.emit('exit');}
}
const runtime=await createApp(config,()=>new InspectionHarness());
const project=await runtime.tree.createProject(globalThis.crypto.randomUUID(), `${campaign.toUpperCase()} presentation qualification`),node=randomUUID(),worker=randomUUID();
await runtime.tree.mutate(project.id,{operationId:randomUUID(),revision:0,command:{kind:'node.create',id:node,title:'Native presentation',description:'Synthetic source; no model request'}});
runtime.agents.create(project.id,node,worker,'Native trajectory and math');await runtime.agents.resume(project.id,node,worker);await runtime.agents.closeWorker(project.id,node,worker);
const home=join(stateRoot,'harness',worker),ctx=new Context();await ctx.plugin(LocalAttachmentStore,{dshHome:home});
const [image]=await ctx.attachments.saveImages([{data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC','base64'),mediaType:'image/png',name:'fixture.png'}]);
await ctx.plugin(JsonlSessionPersistence,{root:join(home,'sessions')});
const source=Session.create(harnessSessionId,undefined,{version:SESSION_FORMAT_VERSION,id:harnessSessionId,createdAt:1000,isSeeded:false,cwd:runtime.tree.workspace(project.id,node)});
source.append('turn/start',{turn:1});source.append('user/message',createUserMessage({content:[{type:'text',text:'Inspect math, code, and the retained image.'},{type:'image',attachment:image}],source:{kind:'user'}}),{surfaceOp:'append'});
source.append('step/start',{turn:1,step:1});
source.append('request/header',{reason:'initial',header:{config:{provider:'synthetic-qualification',model:'no-model'}}});
source.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'Equation: $E=mc^2$.\n\n$$\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}$$\n\n```python\nprint("native renderer")\n```\n\n| Case | Result |\n|---|---|\n| Math | rendered |\n\n[Reference](https://example.com) and escaped \\*literal\\*.'}],source:{kind:'model',provider:'synthetic-qualification',model:'no-model'}}),stream:[],usage:{inputTokens:10,outputTokens:20,totalTokens:30,cacheReadTokens:5}}, {surfaceOp:'append'});
source.append('tool/call',{turn:1,step:1,callId:'fixture-tool',name:'read',arguments:JSON.stringify({path:'notes.md'})});
source.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:'fixture-tool',isError:false,content:[{type:'text',text:'# Workspace preview\n\n$E=mc^2$'}]})},{surfaceOp:'append'});
source.append('step/end',{turn:1,step:1});source.append('turn/end',{turn:1,reason:{kind:'completed'}});
const compactionId=CompactionId('native-compaction');
const compactStart=source.append('compaction/start',{compactionId,turn:1});
const compactSummary=source.append('compaction/summary',{compactionId,summary:[{type:'text',text:'Preserved math, image and tool evidence.'}],shadowedRange:{start:1,end:1},shadowedSeqs:[1],shadowedTokenCount:10,provider:'synthetic-qualification',model:'no-model'});
source.append('user/message',createUserMessage({content:[{type:'text',text:'Preserved math, image and tool evidence.'}],source:compactCheckpointSource(compactionId)}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[compactStart.seq,compactSummary.seq,1]});
source.append('compaction/end',{compactionId,turn:1});
const writer=await ctx.sessionPersistence.create(source.header);await writer.append(source.snapshotEvents());await writer.flush();await writer.close();await ctx.fiber.dispose();
await writeFile(join(runtime.tree.workspace(project.id,node),'notes.md'),`# Renderer boundary fixture\n\nInline $E=mc^2$ and display:\n\n$$\\frac{1}{2}$$\n\n<img src=x onerror="alert(1)">\n\n[Unsafe](javascript:alert(1))\n\nMalformed $\\notacommand{x}$ remains inspectable.\n\n\`\`\`python\nprint("unfinished fence")\n`);
await runtime.app.listen({host:'127.0.0.1',port:config.port});
await writeFile(join(directory,'presentation-state.json'),JSON.stringify({stateRoot,project:project.id,node,worker}));
console.log(runtime.launchUrl);
process.once('SIGINT',()=>void runtime.app.close());process.once('SIGTERM',()=>void runtime.app.close());
