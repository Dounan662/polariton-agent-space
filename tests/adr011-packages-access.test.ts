import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,realpath,rm,stat,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {RackConfig,type AccessRequest,type ConnectionRevision,type Revision,type Realization} from '../src/environment/contracts.ts';

/** Access binds a shared immutable definition to one worker, without borrowing another
 * worker's workspace or acquiring writable resources for the definition itself. */
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-package-access-'))),executable=await realpath(process.execPath),script=join(root,'server.mjs');
  const first=join(root,'workspace one'),second=join(root,'workspace two');await Promise.all([mkdir(first),mkdir(second),writeFile(script,'// inspected, never executed by preparation\n')]);
  const config=RackConfig.parse({stateRoot:join(root,'rack'),socketPath:join(root,'rack.sock'),executablePaths:[dirname(executable)],monitorMs:3600000});
  const backend=new Proxy({},{get(){return async()=>{throw new Error('External-only access must not contact Docker');};}}) as RackBackend;
  let rack=await new EnvironmentRack(config,()=>backend).open();
  t.after(async()=>{await rack.close();await rm(root,{recursive:true,force:true});});
  async function capability(args:string[],env:Record<string,string>={}){
    const preview=await rack.preview({configuration:{mcpServers:{shared:{command:executable,args:[script,...args],env}}},resolutions:{}});
    assert.deepEqual(preview.errors,[]);
    const imported=await rack.execute({kind:'capability.import',operationId:'import',entries:preview.entries}) as {capabilities:ConnectionRevision[]};return imported.capabilities[0]!;
  }
  async function published(definition:ConnectionRevision,exclusive=false){
    const revision=await rack.execute({kind:'environment.publish',operationId:'published',expectedBase:null,document:{format:2,environmentId:'shared',name:'Shared',description:'',components:[{id:'tool',name:'Tool',definition:{capabilityId:definition.id,revisionId:definition.revisionId},...(exclusive?{resource:{identity:'one-desktop-application',exclusive:true}}:{})}]}}) as Revision;
    const applied=await rack.execute({kind:'environment.apply',operationId:'applied',environmentId:revision.environmentId,revisionId:revision.revisionId}) as Realization;assert.equal(applied.status,'ready');return revision;
  }
  const request=(revision:Revision,id:string,workspace=first):AccessRequest=>({id,owner:'main',principal:id,workspace,environment:{environmentId:revision.environmentId,revisionId:revision.revisionId,name:revision.name},requireHead:true});
  return {root,first,second,script,capability,published,request,get rack(){return rack;},async restart(){await rack.close();rack=await new EnvironmentRack(config,()=>backend).open();}};
}
function stdio(grant:Awaited<ReturnType<EnvironmentRack['acquireAccess']>>){const server=grant.servers[0]!;assert('command' in server);return server;}

test('one environment binds workspace arguments and environment values independently for each worker',async t=>{
  const f=await fixture(t),definition=await f.capability(['--root','${POLARITON_WORKSPACE}/data'],{WORK_DIRECTORY:'${POLARITON_WORKSPACE}'}),revision=await f.published(definition);
  const a=stdio(await f.rack.acquireAccess(f.request(revision,'worker-a'))),b=stdio(await f.rack.acquireAccess(f.request(revision,'worker-b',f.second)));
  assert.equal(a.command,b.command);assert.deepEqual(a.args,[f.script,'--root',`${f.first}/data`]);assert.deepEqual(b.args,[f.script,'--root',`${f.second}/data`]);
  assert.deepEqual(a.env,[{name:'WORK_DIRECTORY',value:f.first}]);assert.deepEqual(b.env,[{name:'WORK_DIRECTORY',value:f.second}]);
  const stored=await f.rack.capability(definition.id,definition.revisionId);assert('args' in stored!);assert.equal(stored.args[2],'${POLARITON_WORKSPACE}/data');
  await assert.rejects(f.rack.acquireAccess({...f.request(revision,'worker-a'),workspace:f.second}));
});

test('runtime directories have per-access ownership, survive restart and disappear only on their own release',async t=>{
  const f=await fixture(t),revision=await f.published(await f.capability(['--scratch','${POLARITON_RUNTIME}'],{RUNTIME_DIRECTORY:'${POLARITON_RUNTIME}'}));
  const requestA=f.request(revision,'worker-a'),requestB=f.request(revision,'worker-b',f.second),a=stdio(await f.rack.acquireAccess(requestA)),b=stdio(await f.rack.acquireAccess(requestB));
  const runtimeA=a.args[2]!,runtimeB=b.args[2]!;assert.notEqual(runtimeA,runtimeB);assert((await stat(runtimeA)).isDirectory());assert.equal((await stat(runtimeA)).mode&0o777,0o700);
  await writeFile(join(runtimeA,'a'),'worker a');await writeFile(join(runtimeB,'b'),'worker b');await f.restart();
  assert.deepEqual(stdio(await f.rack.acquireAccess(requestA)),a);
  await f.rack.releaseAccess({id:requestA.id,owner:requestA.owner});await assert.rejects(stat(runtimeA),{code:'ENOENT'});assert((await stat(join(runtimeB,'b'))).isFile());
  assert.deepEqual(stdio(await f.rack.acquireAccess(requestB)),b);await f.rack.releaseAccess({id:requestB.id,owner:requestB.owner});await assert.rejects(stat(runtimeB),{code:'ENOENT'});
  await assert.rejects(f.rack.acquireAccess(requestA),{code:'ACCESS_RELEASED'});
});

test('missing workspace blocks acquisition before a usable connection is issued',async t=>{
  const f=await fixture(t),revision=await f.published(await f.capability(['${POLARITON_WORKSPACE}']));
  await assert.rejects(f.rack.acquireAccess(f.request(revision,'missing',join(f.root,'absent'))));
  await assert.rejects(f.rack.acquireAccess(f.request(revision,'relative','relative/path')));
});

test('a failed retry cannot delete runtime still owned by an issued access',async t=>{
  const f=await fixture(t),revision=await f.published(await f.capability(['${POLARITON_RUNTIME}']),true),request=f.request(revision,'issued');
  const access=stdio(await f.rack.acquireAccess(request)),runtime=access.args[1]!;
  await writeFile(join(runtime,'owned'),'still in use');
  await writeFile(f.script,'// drifted executable identity\n');
  assert.equal((await f.rack.acquireAccess(request)).components[0]?.code,'CONNECTION_UNAVAILABLE');
  assert((await stat(join(runtime,'owned'))).isFile(),'Only the owner may release scratch after settling its guardian');
  await writeFile(f.script,'// inspected, never executed by preparation\n');
  assert.equal((await f.rack.acquireAccess(f.request(revision,'worker-b',f.second))).components[0]?.code,'RESOURCE_BUSY');
  await f.rack.releaseAccess({id:request.id,owner:request.owner});await assert.rejects(stat(runtime),{code:'ENOENT'});
});

test('separate workspaces do not bypass an exclusive application resource',async t=>{
  const f=await fixture(t),revision=await f.published(await f.capability(['${POLARITON_WORKSPACE}']),true);
  await f.rack.acquireAccess(f.request(revision,'worker-a'));
  assert.equal((await f.rack.acquireAccess(f.request(revision,'worker-b',f.second))).components[0]?.code,'RESOURCE_BUSY');
  await f.rack.releaseAccess({id:'worker-a',owner:'main'});assert.equal((await f.rack.acquireAccess(f.request(revision,'worker-b',f.second))).servers.length,1);
});

test('runtime variables are not credentials and arbitrary shell expansion remains invalid',async t=>{
  const f=await fixture(t);
  const preview=await f.rack.preview({configuration:{mcpServers:{bad:{command:process.execPath,args:[f.script,'${HOME}']},shell:{command:process.execPath,args:[f.script,'$(pwd)']},http:{url:'https://example.invalid/mcp',headers:{Authorization:'Bearer ${POLARITON_WORKSPACE}'}}}},resolutions:{}});
  assert.equal(preview.entries.length,0);assert.equal(preview.errors.length,3);
});


for(const version of [3,5,6,7])test(`incompatible environment format ${version} is rejected and its experiment records are retained`,async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-old-package-state-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'operations.sqlite'),db=new DatabaseSync(file);db.exec(`PRAGMA user_version=${version}; CREATE TABLE experiments(id TEXT PRIMARY KEY,body TEXT NOT NULL)`);db.prepare('INSERT INTO experiments VALUES(?,?)').run('existing','retain this experiment');db.close();
  const original=await readFile(file),config=RackConfig.parse({stateRoot:root,socketPath:join(root,'rack.sock')});await assert.rejects(new EnvironmentRack(config).open(),{code:'STATE_FORMAT'});
  assert.deepEqual(await readFile(file),original);
  const retained=new DatabaseSync(file,{readOnly:true});try{assert.equal(retained.prepare('PRAGMA user_version').get()!.user_version,version);assert.equal(retained.prepare('SELECT body FROM experiments WHERE id=?').get('existing')!.body,'retain this experiment');}finally{retained.close();}
});
