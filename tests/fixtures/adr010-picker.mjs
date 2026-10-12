import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../src/main.ts';
import {loadConfig,sourceRoot} from '../../src/config.ts';
import {Harness} from '../../harness/client.ts';

// Manual built-browser regression for scoped revision identity. The fake rack
// deliberately offers the same revision name in two environments. Real DSH reads
// its catalog, but provider admission is denied and activation is not exercised.
const root=await mkdtemp(join(sourceRoot,'.local/adr010/picker-'));
// Keep socket identity below macOS's path limit even with a long per-user TMPDIR.
const socket=join('/tmp',`polariton-picker-${randomUUID()}.sock`);
const choices=['first','second'].map(id=>({environment:{environmentId:id,revisionId:'r1',name:`Scoped ${id}`},observedAt:new Date().toISOString()}));
const rack=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/access/choices')res.end(JSON.stringify(choices));else{res.statusCode=404;res.end('{}');}});
await new Promise(resolve=>rack.listen(socket,resolve));
await mkdir(join(root,'rack'));await writeFile(join(root,'rack/admin.json'),JSON.stringify({token:'synthetic-browser-test-authority'}));
await writeFile(join(root,'environment.json'),JSON.stringify({stateRoot:join(root,'rack'),socketPath:socket}));
const config={...await loadConfig(),port:4331,stateRoot:join(root,'app'),verification:false,environmentConfig:join(root,'environment.json')};
let deniedRequests=0;
const runtime=await createApp(config,(settings,home,workspace,_budget,permission)=>new Harness(settings,home,workspace,async()=>{deniedRequests++;return false;},permission));
await runtime.app.listen({host:'127.0.0.1',port:config.port});
console.log(runtime.launchUrl);
let closing;
const stop=()=>closing??=(async()=>{
  const workers=runtime.tree.projects().flatMap(project=>runtime.tree.graph(project.id).nodes.flatMap(node=>runtime.agents.list(project.id,node.id)));
  const result={at:new Date().toISOString(),providerRequests:0,deniedRequests,passed:workers.length===1&&workers[0].environment.selection?.environmentId==='second'&&workers[0].environment.selection?.revisionId==='r1'&&workers.every(worker=>!worker.harnessSessionId)&&deniedRequests===0,workers};
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
  await runtime.app.close();await new Promise(resolve=>rack.close(resolve));
  console.log(JSON.stringify({passed:result.passed,evidence:join(root,'result.json')}));
})();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop().catch(error=>{console.error(error);process.exitCode=1;}));
