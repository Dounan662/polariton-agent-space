import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadConfig} from '../src/config.ts';
import {EnvironmentRack} from '../src/environment/rack.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {officialDigest} from '../src/environment/catalog.ts';
import {environmentOperation} from '../src/cli/environment-operations.ts';
import {CallerAccess,serveApplication} from '../src/cli/server.ts';

const exec=promisify(execFile);
/** Exercise the real executable, authentication and owner contracts. Only the peer
 * forwarding hop is replaced; distribution is injected into the real rack owner. */
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-catalog-cli-')));
 const configPath=join(root,'app.json'),config={...await loadConfig(),stateRoot:root,configPath};
 await writeFile(configPath,JSON.stringify(config));
 const rackConfig=RackConfig.parse({stateRoot:join(root,'rack'),socketPath:join(root,'unused.sock'),monitorMs:3600000});
 const value={id:'synthetic-http',version:'2026.1',name:'Controlled official',description:'CLI qualification only',prerequisites:[],configurationRequirements:[],usageSkills:[],definition:{kind:'http',url:'https://example.invalid/mcp',headers:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'}}};
 const entry={...value,digest:officialDigest(value)},manifest={format:1,version:'qualification',entries:[entry]};
 const backend=new Proxy({},{get(){return async()=>{assert.fail('Catalog registration cannot contact a container host');};}});
 const rack=await new EnvironmentRack(rackConfig,()=>backend,manifest).open();
 const access=new CallerAccess(config);await access.initialize();
 const app=await serveApplication(config,access,{execute:(request,actor)=>environmentOperation(rack,request,actor)});
 t.after(async()=>{await app.close();await rack.close();await rm(root,{recursive:true,force:true});});
 const admin=JSON.parse(await readFile(join(root,'application-admin.json'),'utf8')).token;
 const worker=access.issue(randomUUID(),randomUUID()).token;
 async function cli(args,token=admin){
  // These cases inspect retained catalog provenance rather than compact presentation.
  if(args[1]==='provision'||args[0]==='operation')args=[...args,'--details'];
  const env={...process.env};delete env.DSH_SHELL;delete env.DSH_HARNESSCTL_TOKEN;delete env.HARNESSCTL_TOKEN;env.HARNESSCTL_TOKEN=token;
  let result,code=0;
  try{result=await exec(process.execPath,['bin/harnessctl',...args,'--config',configPath],{env,timeout:config.requestTimeoutMs,maxBuffer:config.cliMaxStreamBytes});}
  catch(error){if(typeof error.code!=='number'||typeof error.stdout!=='string')throw error;result=error;code=error.code;}
  return {code,data:JSON.parse(result.stdout),stderr:result.stderr};
 }
 return {rack,cli,worker,entry};
}

test('authenticated catalog CLI lists, inspects and provisions a synthetic exact version with retained retries',async t=>{
 const f=await fixture(t);
 const list=await f.cli(['catalog','list']);assert.equal(list.code,0);assert.equal(list.data.data.catalogVersion,'qualification');assert.equal(list.data.data.items[0].state,'unprovisioned');
 const before=await f.cli(['catalog','get',f.entry.id]);assert.equal(before.code,0);assert.equal(before.data.data.versions[0].entry.digest,f.entry.digest);assert.equal((await f.rack.inventory()).capabilities.length,0);
 const requestId=randomUUID(),args=['catalog','provision',f.entry.id,'--version',f.entry.version,'--request-id',requestId];
 const created=await f.cli(args);assert.equal(created.code,0,JSON.stringify(created.data));const receipt=created.data.data;assert.equal(receipt.state,'succeeded');assert.equal(receipt.actor.kind,'owner');assert.equal(receipt.result.state,'registered');assert.equal(receipt.result.origin.digest,f.entry.digest);
 assert.deepEqual((await f.cli(args)).data,created.data);
 const recovered=await f.cli(['operation','get',`environment:${requestId}`]);assert.equal(recovered.code,0);assert.deepEqual(recovered.data,created.data);
 const after=await f.cli(['catalog','get',f.entry.id]);assert.equal(after.data.data.versions[0].capabilityId,receipt.result.capabilityId);assert.equal(after.data.data.versions[0].state,'registered');
 const conflict=await f.cli(['catalog','provision',f.entry.id,'--version','different','--request-id',requestId]);assert.equal(conflict.code,3);assert.equal(conflict.data.error.code,'OPERATION_CONFLICT');
 const install=await f.cli(['catalog','provision',f.entry.id,'--version',f.entry.version,'--install','--request-id',randomUUID()]);assert.equal(install.code,6);assert.equal(install.data.data.error.code,'CATALOG_INSTALL');
 const inventory=await f.rack.inventory();assert.equal(inventory.capabilities.length,1);assert.equal(inventory.releases.length,0);assert.equal(inventory.mounts.length,0);
 assert.deepEqual(JSON.parse(await readFile(new URL('../catalog/official.json',import.meta.url),'utf8')),{format:1,version:'1',entries:[]});
});

test('worker catalog reads succeed but provisioning and invalid credentials cannot reach mutation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.cli(['catalog','list'],f.worker)).code,0);
 assert.equal((await f.cli(['catalog','get',f.entry.id],f.worker)).code,0);
 const denied=await f.cli(['catalog','provision',f.entry.id,'--version',f.entry.version,'--request-id',randomUUID()],f.worker);assert.equal(denied.code,4);assert.equal(denied.data.error.code,'ACTOR_DENIED');
 const invalid=await f.cli(['catalog','list'],'invalid');assert.equal(invalid.code,4);assert.equal(invalid.data.error.code,'AUTH_REQUIRED');
 assert.equal((await f.rack.inventory()).capabilities.length,0);assert.equal((await f.rack.inventory()).operations.length,0);
});
