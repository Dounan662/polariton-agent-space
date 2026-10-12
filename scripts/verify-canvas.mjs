/** Real CLI -> Main -> connected browser qualification. The optional live phase
 * asks a real worker to position cards, inspect a temporary PNG, and finish inspection. All state is fresh. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile,stat,realpath,readdir} from 'node:fs/promises';
import {join,isAbsolute,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import sharp from 'sharp';
import {loadConfig,Config,sourceRoot} from '../src/config.ts';
import {createApp} from '../src/main.ts';
import {Harness} from '../harness/client.ts';
import {ProviderSettings} from '../harness/providers.ts';
import {VerificationBudget} from '../harness/budget.mjs';

const args=process.argv.slice(2),live=args.includes('--live');
assert(args[0]&&args[1],'Supply an installed Playwright module path and browser executable');
const {chromium}=await import(pathToFileURL(args[0]).href);
const positive=z.number().int().positive();
const limits=z.object({port:positive,commandTimeoutMs:positive,commandBytes:positive,browserTimeoutMs:positive,maxRequests:positive.max(20),maxLiveMs:positive.max(600000),maxOutputTokens:positive.max(4096),maxRequestsPerTurn:positive.max(16),pollMs:positive}).strict().parse(JSON.parse(await readFile(new URL('../config/adr027-validation.json',import.meta.url),'utf8')));
if(live)assert(process.env.DEEPSEEK_API_KEY,'Normal V5 provider environment is required for --live');
const runId=new Date().toISOString().replaceAll(':','-'),run=join(sourceRoot,'.local/adr027',runId),evidence=join(sourceRoot,'docs/evidence/adr027',runId);
await mkdir(run,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true});
const configPath=join(run,'app.json'),environmentConfig=join(run,'environment.json');
await writeFile(environmentConfig,JSON.stringify({...JSON.parse(await readFile(new URL('../config/environment.json',import.meta.url),'utf8')),stateRoot:join(run,'environment'),socketPath:join('/tmp',`polariton-027-${randomUUID()}.sock`)}));
const config=Config.parse({...await loadConfig(),port:limits.port,configPath,stateRoot:join(run,'state'),runtimeDirectory:join('/tmp',`polariton-027-${randomUUID().slice(0,8)}`),environmentConfig,sharedSkillsDir:join(run,'skills'),verification:false,campaign:undefined,maxOutputTokens:limits.maxOutputTokens,maxRequestsPerTurn:limits.maxRequestsPerTurn,workerIdleUnloadMs:null});
await writeFile(configPath,JSON.stringify(config));await mkdir(config.sharedSkillsDir);
const report={runId,live,passed:false,checks:[],requests:0,browserErrors:[],source:{}};
for(const file of ['src/canvas.ts','src/canvas-snapshots.ts','src/canvas-contracts.ts','web/src/graph-layout.ts','web/src/graph.tsx','web/src/canvas-bridge.ts','web/src/canvas-render.tsx','package-lock.json']){try{report.source[file]=createHash('sha256').update(await readFile(join(sourceRoot,file))).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;}}
const check=(name,detail={})=>{report.checks.push({name,...detail});console.log(JSON.stringify({check:name,...detail}));};
let runtime,browser,context,ledger;const harnesses=[];
const save=()=>writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
async function cli(command,input={},options={}){
 const mutation=options.mutation,argv=[join(sourceRoot,'bin/harnessctl'),'--config',configPath,...command.split('.'),'--input','-',...(mutation?['--request-id',options.requestId??randomUUID(),...(command==='canvas.move'?[]:['--details'])]:[]),...(options.output?['--output',options.output]:[])];
 const env={...process.env};for(const key of ['HARNESSCTL_TOKEN','DSH_HARNESSCTL_TOKEN','DSH_SHELL'])delete env[key];
 const child=spawn(process.execPath,argv,{cwd:run,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',size=0;
 const timer=setTimeout(()=>child.kill('SIGTERM'),limits.commandTimeoutMs);
 const collect=(which,chunk)=>{size+=chunk.length;if(size>limits.commandBytes){child.kill('SIGTERM');return;}if(which==='stdout')stdout+=chunk;else stderr+=chunk;};
 child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
 let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
 assert(size<=limits.commandBytes);let value;try{value=JSON.parse(stdout);}catch{throw new Error(`Invalid CLI output: ${stdout} ${stderr}`);}
 if(options.failure){assert.equal(value.error?.code,options.failure,JSON.stringify(value));return value;}
 assert.equal(code,0,JSON.stringify(value));return value.data;
}
async function until(fn,label){const end=Date.now()+limits.browserTimeoutMs;while(Date.now()<end){const value=await fn();if(value)return value;await delay(limits.pollMs);}throw new Error(`Deadline: ${label}`);}
function outside(root,path){const child=relative(root,path);return child==='..'||child.startsWith(`..${sep}`)||isAbsolute(child);}
async function temporary(snapshot,research){
 assert(isAbsolute(snapshot.output),'Temporary snapshots return absolute readable paths');
 assert(Number.isFinite(snapshot.expiresAt)&&snapshot.expiresAt>Date.now(),'Default snapshots must have a future expiry');
 assert(outside(await realpath(research),await realpath(snapshot.output)),'Inspection PNG must remain outside research workspaces');
 assert(!('data' in snapshot),'CLI snapshot result contains metadata rather than inline image data');
 const bytes=await readFile(snapshot.output);assert.equal(bytes.length,snapshot.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),snapshot.sha256);
 const metadata=await sharp(bytes).metadata();assert.equal(metadata.format,'png');assert.equal(metadata.width,snapshot.width);assert.equal(metadata.height,snapshot.height);
 return snapshot;
}
try{
 if(live){const providers=await ProviderSettings.open(join(config.stateRoot,'provider-settings'),{discoveryTimeoutMs:config.providerDiscoveryTimeoutMs,lockTimeoutMs:config.startupTimeoutMs});try{await providers.save({id:config.provider,kind:'builtin'});await providers.setDefault(JSON.stringify([config.provider,config.model]));}finally{await providers.close();}ledger=new VerificationBudget(join(run,'budget.sqlite'),limits);}
 runtime=await createApp(config,live?(settings,home,workspace,budget,permission)=>{const h=new Harness(settings,home,workspace,async()=>{const ok=await budget()&&ledger.reserve();if(ok)report.requests++;return ok;},permission);harnesses.push(h);return h;}:undefined);
 await runtime.app.listen({host:'127.0.0.1',port:config.port});
 const project=(await cli('project.create',{name:'Canvas qualification',root:join(run,'research')},{mutation:true})).result;
 let graph=await cli('graph.get',{project:project.id});
 for(const title of ['Collect evidence','Independent check','Synthesis']){await cli('node.create',{project:project.id,expectRevision:graph.revision,title},{mutation:true});graph=await cli('graph.get',{project:project.id});}
 const nodes=graph.nodes;
 for(const [from,to,label] of [[0,1,'investigates'],[1,2,'checked by'],[2,3,'informs'],[3,1,'raises questions']]){await cli('relation.create',{project:project.id,expectRevision:graph.revision,from:nodes[from].id,to:nodes[to].id,label},{mutation:true});graph=await cli('graph.get',{project:project.id});}
 await cli('canvas.get',{project:project.id},{failure:'CANVAS_UNAVAILABLE'});check('closed-ui-unavailable');
 browser=await chromium.launch({headless:true,executablePath:args[1]});report.browser=browser.version();
 context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 await context.addInitScript(({project,node})=>{localStorage.setItem('polariton.project',project);localStorage.setItem('polariton.node',node);localStorage.setItem('polariton.surface','graph');},{project:project.id,node:project.mainNodeId});
 const page=await context.newPage();page.setDefaultTimeout(limits.browserTimeoutMs);page.on('pageerror',e=>report.browserErrors.push(e.message));
 await page.goto(runtime.launchUrl);await page.locator('.graph-wrap .react-flow__node').first().waitFor();
 let state=await cli('canvas.get',{project:project.id});const canvas=state.canvas;
 assert.equal(state.nodes.length,nodes.length);assert(state.nodes.every(n=>n.width>0&&n.height>0));
 const viewport=()=>page.locator('.graph-wrap .react-flow__viewport').evaluate(element=>{const matrix=new DOMMatrix(getComputedStyle(element).transform);return {x:matrix.e,y:matrix.f,zoom:matrix.a};});
 const pane=await page.locator('.graph-wrap').boundingBox();assert(pane);
 await page.mouse.move(pane.x+pane.width/2,pane.y+pane.height/2);
 const initialCamera=await viewport();await page.mouse.wheel(120,90);
 const panned=await until(async()=>{const v=await viewport();return v.x!==initialCamera.x&&v.y!==initialCamera.y?v:null;},'two-axis trackpad pan');
 assert.equal(panned.zoom,initialCamera.zoom,'Ordinary scrolling pans without zooming');
 // Chromium delivers trackpad pinch through control-modified wheel events.
 await page.keyboard.down('Control');try{await page.mouse.wheel(0,100);}finally{await page.keyboard.up('Control');}
 const pinched=await until(async()=>{const v=await viewport();return v.zoom<panned.zoom?v:null;},'trackpad pinch zoom');
 await until(async()=>{const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).viewport,`polariton.graph.${project.id}`);return saved&&Math.abs(saved.zoom-pinched.zoom)<0.00001;},'gesture camera persisted');
 const afterGesture=await cli('canvas.get',{project:project.id,canvas});assert.equal(afterGesture.revision,state.revision);assert.deepEqual(afterGesture.nodes,state.nodes);
 check('two-finger-pan-and-pinch-zoom-preserve-card-layout');
 const beforeMove=await temporary(await cli('canvas.snapshot',{project:project.id,canvas}),project.root);
 await copyFile(beforeMove.output,join(evidence,'before-positioning.png'));
 const position=nodes.map((n,i)=>({id:n.id,x:i*340,y:i%2*260})),requestId=randomUUID();
 const moved=await cli('canvas.move',{project:project.id,canvas,expectRevision:state.revision,positions:position},{mutation:true,requestId});
 await until(async()=>JSON.parse(await page.evaluate(key=>localStorage.getItem(key),`polariton.graph.${project.id}`)).positions[nodes[3].id]?.x===1020,'worker move persisted');
 assert.deepEqual(await cli('canvas.move',{project:project.id,canvas,expectRevision:state.revision,positions:position},{mutation:true,requestId}),moved);
 assert.equal((await stat(beforeMove.output)).size,beforeMove.bytes,'Moving cards must retain the before image for comparison');
 check('batch-positioning-persisted-and-retry-idempotent');
 await page.getByRole('button',{name:'Fit view',exact:true}).click();
 state=await cli('canvas.get',{project:project.id,canvas});
 const card=page.locator(`.graph-wrap .react-flow__node[data-id="${nodes[1].id}"]`),box=await card.boundingBox();assert(box);
 await page.mouse.move(box.x+box.width/2,box.y+30);await page.mouse.down();await page.mouse.move(box.x+box.width/2+55,box.y+90,{steps:8});
 await cli('canvas.move',{project:project.id,canvas,expectRevision:state.revision,positions:[{id:nodes[0].id,x:0,y:0}]},{mutation:true,failure:'CANVAS_BUSY'});
 await page.mouse.up();
 const dragged=await cli('canvas.get',{project:project.id,canvas});assert.notEqual(dragged.revision,state.revision);assert.notDeepEqual(dragged.nodes.find(n=>n.id===nodes[1].id),state.nodes.find(n=>n.id===nodes[1].id));
 await cli('canvas.move',{project:project.id,canvas,expectRevision:state.revision,positions:[{id:nodes[1].id,x:0,y:0}]},{mutation:true,failure:'CANVAS_STALE'});
 check('human-drag-busy-and-stale-worker-protection');
 const camera=()=>page.locator('.graph-wrap .react-flow__viewport').getAttribute('style');
 const before=await camera(),selected=await page.locator('.graph-wrap .react-flow__node.selected').getAttribute('data-id');
 const afterMove=await temporary(await cli('canvas.snapshot',{project:project.id,canvas}),project.root);
 assert.notEqual(afterMove.output,beforeMove.output);assert.equal((await stat(beforeMove.output)).size,beforeMove.bytes);
 check('temporary-inspection-images-survive-position-changes',{before:beforeMove.output,after:afterMove.output,expiresAt:afterMove.expiresAt});
 const snapshot=await cli('canvas.snapshot',{project:project.id,canvas},{output:join(evidence,'whole-graph.png')});assert.equal(snapshot.mediaType,'image/png');assert.equal(snapshot.expiresAt,null);const pixels=await sharp(join(evidence,'whole-graph.png')).stats();assert(pixels.channels.some(channel=>channel.stdev>1),'Exported PNG must contain visible graph content, not a blank canvas');assert.equal(await camera(),before);assert.equal(await page.locator('.graph-wrap .react-flow__node.selected').getAttribute('data-id'),selected);
 const focused=await cli('canvas.snapshot',{project:project.id,canvas,node:nodes[1].id},{output:join(evidence,'neighborhood.png')});assert.equal(focused.expiresAt,null);
 assert.equal(await page.locator('.graph-wrap .graph-node').filter({hasText:'Independent workspace'}).count(),0);assert.equal(await page.locator('.graph-wrap .graph-node').filter({hasText:'Initial project workspace'}).count(),0);assert.equal(await page.locator('.graph-wrap .graph-node').filter({hasText:'RESEARCH NODE'}).count(),0);
 await page.screenshot({path:join(evidence,'visible-ui.png')});check('whole-graph-snapshot-preserves-camera-and-selection',{width:snapshot.width,height:snapshot.height});
 await page.reload();await page.locator('.graph-wrap .react-flow__node').first().waitFor();
 state=await cli('canvas.get',{project:project.id});assert.deepEqual(state.nodes.map(({id,x,y})=>({id,x,y})),dragged.nodes.map(({id,x,y})=>({id,x,y})));assert.equal(state.revision,dragged.revision);assert.notEqual(state.canvas,canvas);
 await cli('canvas.get',{project:project.id,canvas},{failure:'CANVAS_UNAVAILABLE'});check('reload-restores-layout-and-disconnected-identity-is-not-rerouted');
 const second=await context.newPage();await second.goto(`http://127.0.0.1:${config.port}/`);await second.locator('.graph-wrap .react-flow__node').first().waitFor();
 await cli('canvas.get',{project:project.id},{failure:'CANVAS_AMBIGUOUS'});
 const sync=await cli('canvas.move',{project:project.id,canvas:state.canvas,expectRevision:state.revision,positions:[{id:nodes[0].id,x:-200,y:50}]},{mutation:true});
 await until(async()=>JSON.parse(await second.evaluate(key=>localStorage.getItem(key),`polariton.graph.${project.id}`)).positions[nodes[0].id]?.x===-200,'second tab storage sync');
 await second.close();state=await cli('canvas.get',{project:project.id,canvas:state.canvas});assert.equal(state.revision,sync.revision);check('multiple-browser-selection-and-shared-tab-storage');
 if(live){
  const workspace=(await cli('node.get',{target:project.mainNodeId})).workspace;
  const task=`Qualify Polariton canvas presentation. Use harnessctl help for canvas. Read canvas get --project ${project.id} --canvas ${state.canvas}. Move node ${nodes[3].id} to x=1100,y=420 using the returned presentation revision and a retained UUID request ID. Capture the whole canvas with canvas snapshot --project ${project.id} --canvas ${state.canvas}, using its default temporary output (do not pass --output). Open the absolute output path returned by the command with your native read_image tool. Write canvas-inspection.txt briefly describing the actual card arrangement and at least two visible node titles; include the inspected temporary path and expiry. Do not infer the image contents solely from graph JSON. After reading the image, run canvas finish --project ${project.id} to remove your temporary inspection images. Do not copy or save any PNG in your workspace. Do not create nodes, workers, relations, goals or subagents. Do not modify private application data. End after recording your inspection and finishing cleanup. Do not publish a checkpoint for this temporary qualification text.`;
  await cli('worker.send',{target:project.initialWorkerId,text:task},{mutation:true});
  const stop=Date.now()+limits.maxLiveMs;
  while(Date.now()<stop){const worker=runtime.agents.get(project.initialWorkerId);if(worker.permissions.length)throw new Error('Live worker requires user permission; qualification will not auto-approve');if(['failed','uncertain'].includes(worker.state))throw new Error(`Live worker ${worker.state}: ${worker.error}`);if(worker.state==='idle')break;await delay(limits.pollMs);}
  assert.equal(runtime.agents.get(project.initialWorkerId).state,'idle','Worker must finish within live budget');
  const history=await cli('worker.history',{target:project.initialWorkerId});const calls=history.events.filter(e=>e.type==='tool/call');
  assert(calls.some(e=>e.data.name==='bash'&&e.data.arguments.includes('canvas move')));assert(calls.some(e=>e.data.name==='bash'&&e.data.arguments.includes('canvas snapshot')));
  const imageCalls=calls.filter(e=>e.data.name==='read_image');assert(imageCalls.length>0,'Worker must open the temporary PNG with its native image-reading tool');
  assert(calls.some(e=>e.data.name==='bash'&&e.data.arguments.includes('canvas finish')),'Worker must finish temporary image inspection');
  for(const call of imageCalls){
   const result=history.events.find(e=>e.type==='tool/result'&&e.data.message?.source?.callId===call.data.callId);
   assert(result&&!result.data.message.isError&&!result.data.error,'Native image reading must complete successfully, not merely be invoked');
   const inspected=JSON.parse(call.data.arguments).file_path;assert(isAbsolute(inspected));assert(outside(await realpath(project.root),inspected),'Worker must inspect an image outside its research workspace');await assert.rejects(stat(inspected),{code:'ENOENT'},'Worker finish must remove the inspected temporary image');
  }
  assert(!(await readdir(workspace,{recursive:true})).some(file=>file.endsWith('.png')),'Inspection must not leave PNGs in the worker workspace');
  const final=await cli('canvas.get',{project:project.id,canvas:state.canvas});assert.equal(final.nodes.find(n=>n.id===nodes[3].id).x,1100);assert.equal(final.nodes.find(n=>n.id===nodes[3].id).y,420);
  await cli('canvas.snapshot',{project:project.id,canvas:state.canvas},{output:join(evidence,'worker-final-layout.png')});await copyFile(join(workspace,'canvas-inspection.txt'),join(evidence,'worker-inspection.txt'));
  await writeFile(join(evidence,'worker-calls.json'),JSON.stringify(calls,null,2));
  assert.equal((await stat(beforeMove.output)).size,beforeMove.bytes,'Worker finish cannot remove another caller’s temporary snapshots');assert.equal((await stat(afterMove.output)).size,afterMove.bytes);
  check('real-worker-moves-inspects-temporary-image-and-finishes',{requests:report.requests,worker:project.initialWorkerId});
 }
 await context.close();context=undefined;
 await cli('canvas.get',{project:project.id},{failure:'CANVAS_UNAVAILABLE'});
 const finished=await cli('canvas.finish',{project:project.id});assert(finished.removed>=2,'Finish must remove all retained owner inspection snapshots');
 await assert.rejects(stat(beforeMove.output),{code:'ENOENT'});await assert.rejects(stat(afterMove.output),{code:'ENOENT'});
 assert.equal((await cli('canvas.finish',{project:project.id})).removed,0,'Finish is safe to repeat without a browser');
 assert.equal((await stat(snapshot.output)).size,snapshot.bytes);assert.equal((await stat(focused.output)).size,focused.bytes);
 check('finish-without-browser-cleans-temporary-files-and-preserves-explicit-exports',{removed:finished.removed});
 assert.deepEqual(report.browserErrors,[]);report.passed=true;
}catch(error){report.failure={message:error.message,stack:error.stack};process.exitCode=1;console.error(error);if(context?.pages()[0]){const page=context.pages()[0];await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});report.dom=await page.evaluate(()=>({text:document.body.innerText,fonts:document.fonts.status,captures:[...document.querySelectorAll('.graph-capture')].map(e=>({html:e.outerHTML.slice(0,12000)}))})).catch(()=>null);}}finally{
 await save();await context?.close();await browser?.close();await runtime?.app.close();ledger?.close();console.log(JSON.stringify({evidence,passed:report.passed}));
}
