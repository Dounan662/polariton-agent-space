import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {pathToFileURL,fileURLToPath} from 'node:url';
// Disposable browser verification: no provider requests, real accounts or worker execution.
// Build first, run `node scripts/verify-capability-ui.mjs`, then open the printed launcher URL.
const source=fileURLToPath(new URL('..',import.meta.url));
const {loadConfig}=await import(pathToFileURL(join(source,'src/config.ts'))),{createApp}=await import(pathToFileURL(join(source,'src/main.ts'))),{RackConfig}=await import(pathToFileURL(join(source,'src/environment/contracts.ts'))),{createEnvironmentDaemon}=await import(pathToFileURL(join(source,'src/environment/daemon.ts')));
const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adr031-ui-'))),node=await realpath(process.execPath);
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const server=join(root,'fixture.mjs');await writeFile(server,`import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'ui-fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'Return the provided text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:m.params.arguments.text}]};else if(m.method==='resources/list')result={resources:[]};else if(m.method==='resources/templates/list')result={resourceTemplates:[]};else if(m.method==='prompts/list')result={prompts:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
const rackConfig=RackConfig.parse({stateRoot:join(root,'environment'),socketPath:join(root,'environment.sock'),executablePaths:[dirname(node)],oauthCallbackPort:4329,monitorMs:3600000});
const envPath=join(root,'environment.json');await writeFile(envPath,JSON.stringify(rackConfig));const config={...await loadConfig(),port,stateRoot:join(root,'main'),runtimeDirectory:join(root,'runtime'),sharedSkillsDir:join(root,'skills'),environmentConfig:envPath,verification:false,campaign:undefined};await mkdir(config.sharedSkillsDir,{recursive:true});const env=await createEnvironmentDaemon(rackConfig);const app=await createApp(config,()=>{throw new Error('UI qualification must never create a worker');});
const addresses=['gmail','drive','calendar','people','docs','sheets','slides','chat'];
const resource=name=>`https://${name==='people'?'people':`${name}mcp`}.googleapis.com/mcp/v1`;
const imported=await env.rack.preview({configuration:{mcpServers:{'Independent browser fixture':{command:node,args:[server]},'Unconfigured endpoint':{type:'http',url:resource('drive')}}}});
const saved=await env.rack.execute({kind:'capability.import',operationId:'fixture-import',entries:imported.entries});
await env.rack.execute({kind:'environment.publish',operationId:'fixture-publish',expectedBase:null,document:{format:2,environmentId:'fixture-context',name:'Browser work',description:'Independent environment; capability authentication must not change this composition',components:[{id:'browser',name:'Browser fixture',definition:{capabilityId:saved.capabilities[0].id,revisionId:saved.capabilities[0].revisionId}}]}});
const draft=await env.rack.execute({kind:'capability.add',operationId:'33333333-3333-4333-a333-333333333333',input:{name:'Echo tool',specification:{id:'echo',name:'Echo tool',source:{kind:'installed',command:node},runtime:{kind:'local'},connection:{kind:'stdio',args:[server]},requirements:{},authentication:{kind:'none'},checks:[{name:'echo',effects:'read',steps:[{tool:'echo',arguments:{text:'inspector check'}}]},{name:'echo-sample',effects:'write',steps:[{tool:'echo',arguments:{text:'declared write check, harmless echo fixture'}}]}]}}});
const ready=await env.rack.execute({kind:'capability.complete',operationId:'44444444-4444-4444-a444-444444444444',input:{target:draft.operationId,expectedVersion:draft.version,componentId:'echo'}});
const echo=ready.components[0];
await env.rack.execute({kind:'environment.publish',operationId:'fixture-echo-publish',expectedBase:null,document:{format:2,environmentId:'fixture-validation',name:'Tool verification',description:'Validation action layout',components:[{id:'echo',name:'Echo tool',definition:{capabilityId:echo.capabilityId,revisionId:echo.capabilityRevisionId}}]}});
const blocked=await env.rack.execute({kind:'environment.prepare',operationId:'22222222-2222-4222-a222-222222222222',input:{name:'Google Workspace',components:addresses.map(name=>({id:name,name:`Google ${name[0].toUpperCase()+name.slice(1)}`,source:{kind:'endpoint',url:resource(name)},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:`google-${name}`,scopes:[`https://www.googleapis.com/auth/${name}.readonly`]}}))}});
console.log(JSON.stringify({fixturePreparation:blocked.status,pendingCapabilities:blocked.components.length,independentEnvironment:'fixture-context'}));
app.app.get('/ui-test-open',(_request,reply)=>reply.redirect(app.renewLaunch()));
// Reproduce a previous installation's saved navigation through ordinary startup.
// The script is same-origin so the production CSP remains intact.
app.app.get('/ui-test-stale-selection',(_request,reply)=>reply.type('text/html').header('Cache-Control','no-store').send('<!doctype html><html><head><title>Restore saved capability selection</title></head><body><p>Opening Polariton with a saved capability selection…</p><script src="/ui-test-stale-selection.js"></script></body></html>'));
app.app.get('/ui-test-stale-selection.js',(_request,reply)=>{
 const selection={kind:'pending',operationId:'environment:f83e7574-efb8-4791-b655-9a051dba8555',componentId:'gmail'};
 return reply.type('text/javascript').header('Cache-Control','no-store').send(`localStorage.setItem('polariton.module','environment');localStorage.setItem('polariton.capability',${JSON.stringify(JSON.stringify(selection))});location.replace(${JSON.stringify(app.renewLaunch())});`);
});
await app.app.listen({host:'127.0.0.1',port});
const context={root,port,node,server,url:`http://127.0.0.1:${port}/ui-test-open`,staleSelectionUrl:`http://127.0.0.1:${port}/ui-test-stale-selection`};
await writeFile(join(root,'ui-context.json'),JSON.stringify(context,null,2));console.log(JSON.stringify(context));
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.app.close();await env.app.close();console.log('UI verification owners closed');};process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
