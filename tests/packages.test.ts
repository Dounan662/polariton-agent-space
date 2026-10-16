import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Connections } from '../src/environment/connections.ts';
import { Packages, packageLaunch, type PackageExecutor } from '../src/environment/packages.ts';
import { RackConfig, type ConnectionRevision } from '../src/environment/contracts.ts';

async function fixture(t:TestContext,settings:Record<string,unknown>={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-packages-'))),bin=join(root,'bin');await mkdir(bin);
  for(const name of ['npx','npm','node','uvx','uv','python'])await writeFile(join(bin,name),'#!/bin/sh\nexit 99\n',{mode:0o755});
  const config=RackConfig.parse({stateRoot:join(root,'state'),socketPath:join(root,'socket'),executablePaths:[bin],packageTools:{npm:join(bin,'npm'),node:join(bin,'node'),uv:join(bin,'uv'),python:join(bin,'python')},...settings});
  const writable=async(path:string)=>{const info=await lstat(path);if(info.isSymbolicLink())return;if(info.isDirectory()){await chmod(path,0o700);for(const child of await readdir(path))await writable(join(path,child));}else await chmod(path,0o600);};
  t.after(async()=>{await writable(root);await rm(root,{recursive:true,force:true});});
  const connections=new Connections(config);
  const revision=async(command='npx',args=['-y','fixture@1.0.0'],revisionId='revision'):Promise<ConnectionRevision>=>{
    const preview=await connections.preview({configuration:{mcpServers:{fixture:{command:join(bin,command),args}}}});assert.deepEqual(preview.errors,[]);
    return {...preview.entries[0]!.definition,id:'capability',name:'Fixture',revisionId,baseRevisionId:null,operationId:revisionId,createdAt:'2026-01-01T00:00:00.000Z'};
  };
  let calls=0;
  const executor:PackageExecutor=async request=>{
    if(request.args.at(-1)==='--version')return '24.0.0';
    calls++;
    if(request.args.includes('--package-lock-only')){await writeFile(join(request.cwd,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{fixture:'1.0.0'}},'node_modules/fixture':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',integrity:'sha512-fixture'}}}));}
    else if(request.args.includes('ci')){const packageDirectory=join(request.cwd,'node_modules','fixture');await mkdir(packageDirectory,{recursive:true});await writeFile(join(packageDirectory,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',bin:{'mcp-fixture':'cli.js'}}));await writeFile(join(packageDirectory,'cli.js'),'#!/usr/bin/env node\nconsole.log("fixture");\n');}
    else if(request.args.includes('compile'))await writeFile(join(request.cwd,'requirements.lock'),'fixture==1.0.0 --hash=sha256:fixture\n');
    else if(request.args[0]==='venv'){const venv=request.args.at(-1)!;await mkdir(join(venv,'bin'),{recursive:true});await symlink(join(bin,'python'),join(venv,'bin','python'));}
    else if(request.args.includes('install'))await writeFile(join(request.cwd,'venv','bin','fixture'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    else if(request.args.includes('list'))return JSON.stringify([{name:'fixture',version:'1.0.0'}]);
    return '';
  };
  return {root,bin,config,connections,revision,executor,get calls(){return calls;}};
}

test('common launcher forms normalize without executing and reject fetch indirection',()=>{
  assert.deepEqual(packageLaunch('/bin/npx',['-y','@scope/server@2.1.0','--root','${POLARITON_WORKSPACE}']),{recipe:{manager:'npm',specifier:'@scope/server@2.1.0',executable:'server'},args:['--root','${POLARITON_WORKSPACE}']});
  assert.deepEqual(packageLaunch('/bin/uvx',['--from','fixture==1.0.0','server','--verbose']),{recipe:{manager:'uv',specifier:'fixture==1.0.0',executable:'server'},args:['--verbose']});
  assert.deepEqual(packageLaunch('/bin/uvx',['fixture==1.0.0'])?.recipe,{manager:'uv',specifier:'fixture==1.0.0',executable:'fixture'});
  for(const args of [['--package','fixture'],['-y','https://example.test/package.tgz'],['-y','../local'],['-y','git+https://example.test/repo']])assert.throws(()=>packageLaunch('npx',args),{code:'PACKAGE_SPECIFIER'});
  for(const args of [['--with','other','fixture'],['--from','https://example.test/wheel','fixture'],['--from','fixture','../evil']])assert.throws(()=>packageLaunch('uvx',args),{code:'PACKAGE_SPECIFIER'});
  assert.equal(packageLaunch('/installed/server',[]),undefined);
});

test('preview records package intent without creating installation files or launching a tool',async t=>{
  const f=await fixture(t),revision=await f.revision();assert.equal(revision.kind,'stdio');
  if(revision.kind==='stdio')assert.deepEqual(revision.package,{manager:'npm',specifier:'fixture@1.0.0',executable:'fixture'});
  await assert.rejects(readdir(f.config.stateRoot),{code:'ENOENT'});assert.equal(f.calls,0);
  const unknown=await f.connections.preview({configuration:{mcpServers:{x:{command:join(f.bin,'npx'),args:['--package','fixture']}}}});assert.equal(unknown.errors[0]?.code,'PACKAGE_SPECIFIER');
});

test('npm prepares one shared sealed installation and resolve never invokes package tooling',async t=>{
  const f=await fixture(t),revision=await f.revision(),packages=new Packages(f.config,f.executor);
  await assert.rejects(packages.resolve(revision),{code:'PACKAGE_UNPREPARED'});
  await Promise.all([packages.prepare(revision),packages.prepare(revision)]);assert.equal(f.calls,2);
  const first=await packages.resolve(revision);assert.deepEqual(first.installation.packages,[{name:'fixture',version:'1.0.0'}]);assert.match(first.installation.digest,/^[a-f0-9]{64}$/);assert.equal(first.installation.platform,process.platform);assert.equal(first.command,join(f.bin,'node'));assert.equal(first.args.length,1);assert.match(first.args[0]!,/\/state\/packages\/[a-f0-9]{64}\/attempt-[a-f0-9-]+\/installation\//);
  assert.equal((await lstat(first.args[0]!)).mode&0o777,0o444);
  await packages.prepare(revision);assert.equal(f.calls,2);
  const restarted=new Packages(f.config,async()=>{throw new Error('resolve must not launch');});assert.deepEqual(await restarted.resolve(revision),first);await restarted.prepare(revision);
});

test('uv preparation fixes the venv path and records installed dependency versions',async t=>{
  const f=await fixture(t),revision=await f.revision('uvx',['fixture==1.0.0','${POLARITON_WORKSPACE}']),packages=new Packages(f.config,f.executor);
  await packages.prepare(revision);assert.equal(f.calls,4);const launch=await packages.resolve(revision);
  assert(launch.command.endsWith('/installation/venv/bin/fixture'));assert.deepEqual(launch.args,['${POLARITON_WORKSPACE}']);
  assert.equal(await readFile(join(launch.command,'..','..','..','requirements.lock'),'utf8'),'fixture==1.0.0 --hash=sha256:fixture\n');
});

test('changed installation or runtime blocks retained resolution and cannot trigger automatic repair',async t=>{
  const f=await fixture(t),revision=await f.revision(),packages=new Packages(f.config,f.executor);await packages.prepare(revision);
  const launch=await packages.resolve(revision);await chmod(launch.args[0]!,0o644);await writeFile(launch.args[0]!,'changed');
  await assert.rejects(packages.resolve(revision),{code:'PACKAGE_DRIFT'});await assert.rejects(packages.prepare(revision),{code:'PACKAGE_DRIFT'});assert.equal(f.calls,2);
  const next=await f.revision('npx',['fixture@1.0.1'],'next');await packages.prepare(next);await writeFile(join(f.bin,'node'),'changed runtime');await assert.rejects(packages.resolve(next),{code:'PACKAGE_DRIFT'});
});
test('dependency observations share a bounded freshness window while access always rechecks bytes',async t=>{
  const f=await fixture(t,{observationFreshMs:100,maxCapabilities:1}),revision=await f.revision(),packages=new Packages(f.config,f.executor);await packages.prepare(revision);
  let now=Date.parse('2026-10-13T00:00:00Z');const connections=new Connections(f.config,()=>({}),()=>now);
  const [first,concurrent]=await Promise.all([connections.inspectDependencies(revision),connections.inspectDependencies(revision)]);
  assert.deepEqual(concurrent,first);assert.equal(first.installation?.primary?.version,'1.0.0');
  const launch=await packages.resolve(revision);await chmod(launch.args[0]!,0o644);await writeFile(launch.args[0]!,'changed installation');now+=50;
  assert.deepEqual(await connections.inspectDependencies(revision),first,'Polling reuses the timestamped observation');
  await assert.rejects(connections.resolve(revision,'tool'),{code:'PACKAGE_DRIFT'});
  now+=51;const expired=await connections.inspectDependencies(revision);assert.equal(expired.error?.code,'PACKAGE_DRIFT');assert.notEqual(expired.observedAt,first.observedAt);
  now+=1;await assert.rejects(connections.prepare(revision),{code:'PACKAGE_DRIFT'});assert.notEqual((await connections.inspectDependencies(revision)).observedAt,expired.observedAt,'Explicit preparation invalidates even a failed observation');
  const other={...revision,id:'other',revisionId:'other'};await connections.inspectDependencies(other);now+=1;
  assert.equal((await connections.inspectDependencies(revision)).observedAt,new Date(now).toISOString(),'Retained observation keys cannot exceed the configured capability bound');
});

test('installed primary identity distinguishes the selected package from a nested namesake',async t=>{
  const f=await fixture(t),revision=await f.revision('npx',['fixture@latest']);
  const packages=new Packages(f.config,async request=>{
    const result=await f.executor(request);
    if(request.args.includes('--package-lock-only')){const path=join(request.cwd,'package-lock.json'),lock=JSON.parse(await readFile(path,'utf8'));lock.packages['node_modules/another/node_modules/fixture']={version:'0.1.0',resolved:'https://registry.npmjs.org/fixture/-/fixture-0.1.0.tgz',integrity:'sha512-nested'};await writeFile(path,JSON.stringify(lock));}
    return result;
  });
  await packages.prepare(revision);
  assert.deepEqual((await packages.resolve(revision)).installation.primary,{name:'fixture',version:'1.0.0'});
});

test('a settled failed attempt retries the same definition and retained dependency selection',async t=>{
  const f=await fixture(t),revision=await f.revision(),packages=new Packages(f.config,async request=>{if(request.args.includes('ci'))throw new Error('synthetic-secret-sentinel');return f.executor(request);});
  await assert.rejects(packages.prepare(revision),error=>{assert(!String(error).includes('synthetic-secret-sentinel'));return (error as {code:string}).code==='PACKAGE_PREPARATION';});
  assert.equal(f.calls,1);const restart=new Packages(f.config,f.executor);await restart.prepare(revision);assert.equal(f.calls,2);assert.equal((await restart.resolve(revision)).installation.packages[0]!.version,'1.0.0');
});

test('dependency lock rejects nonregistry installation before npm ci',async t=>{
  const f=await fixture(t),revision=await f.revision();let calls=0;
  const packages=new Packages(f.config,async request=>{if(request.args.at(-1)==='--version')return '24.0.0';calls++;await writeFile(join(request.cwd,'package-lock.json'),JSON.stringify({packages:{'':{dependencies:{fixture:'1.0.0'}},'node_modules/fixture':{version:'1.0.0',resolved:'git+https://example.test/repo',integrity:'sha512-fixture'}}}));return '';});
  await assert.rejects(packages.prepare(revision),{code:'PACKAGE_DEPENDENCY'});assert.equal(calls,1);
});

test('storage limits and preparation capacity fail through the public boundary',async t=>{
  const f=await fixture(t,{maxPackageEntries:2}),revision=await f.revision();await assert.rejects(new Packages(f.config,f.executor).prepare(revision),{code:'PACKAGE_LIMIT'});
  const g=await fixture(t);let start!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>start=resolve),release=new Promise<void>(resolve=>finish=resolve);
  const packages=new Packages(g.config,async request=>{start();await release;return g.executor(request);});
  const first=packages.prepare(await g.revision());await started;
  await assert.rejects(packages.prepare(await g.revision('npx',['other@1.0.0'],'other')),{code:'PACKAGE_BUSY'});finish();await first;
});

test('worker placeholders bind independently without becoming credentials or shell expressions',async t=>{
  const f=await fixture(t),server=join(f.root,'server');await writeFile(server,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const preview=await f.connections.preview({configuration:{mcpServers:{fixture:{command:server,args:['--root','${POLARITON_WORKSPACE}/data'],env:{CACHE:'${POLARITON_RUNTIME}/cache'}}}}});assert.deepEqual(preview.errors,[]);
  const definition=preview.entries[0]!.definition;assert.deepEqual(definition.credentials,{});
  const first=await f.connections.resolve(definition,'fixture',{workspace:'/node-a',runtime:'/runtime-a'}),second=await f.connections.resolve(definition,'fixture',{workspace:'/node-b',runtime:'/runtime-b'});
  assert('command' in first&&'command' in second);assert.deepEqual(first.args,['--root','/node-a/data']);assert.deepEqual(second.args,['--root','/node-b/data']);assert.deepEqual(first.env,[{name:'HOME',value:'/runtime-a'},{name:'TMPDIR',value:'/runtime-a'},{name:'CACHE',value:'/runtime-a/cache'}]);
  const bad=await f.connections.preview({configuration:{mcpServers:{header:{url:'https://example.test/mcp',headers:{Authorization:'${POLARITON_WORKSPACE}'}},argument:{command:server,args:['${SECRET}']},shell:{command:server,args:['$(pwd)']}}}});assert.equal(bad.errors.length,3);
});

test('credential bytes stay opaque even when they contain a workspace template',async t=>{
  const f=await fixture(t),credentialFile=join(f.root,'credentials.json'),value='opaque-${POLARITON_WORKSPACE}-${POLARITON_RUNTIME}';
  await writeFile(credentialFile,JSON.stringify({format:1,credentials:{TOKEN:{account:'account',authority:'authority',value}}}),{mode:0o600});
  const connections=new Connections({...f.config,credentialFile}),server=join(f.root,'server');await writeFile(server,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const preview=await connections.preview({configuration:{mcpServers:{server:{command:server,env:{API_TOKEN:'${TOKEN}',CACHE:'${POLARITON_RUNTIME}/cache'}}}}});assert.deepEqual(preview.errors,[]);
  const result=await connections.resolve(preview.entries[0]!.definition,'server',{workspace:'/workspace',runtime:'/runtime'});assert('command' in result);
  assert.deepEqual(result.env,[{name:'HOME',value:'/runtime'},{name:'TMPDIR',value:'/runtime'},{name:'API_TOKEN',value},{name:'CACHE',value:'/runtime/cache'}]);
});

test('retained identity is independent of serialized object key order',async t=>{
  const f=await fixture(t),revision=await f.revision(),packages=new Packages(f.config,f.executor);await packages.prepare(revision);
  const reordered=JSON.parse(JSON.stringify(revision,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
  assert.deepEqual(await packages.resolve(reordered),await packages.resolve(revision));
});

test('real preparation subprocess deadline terminates stubborn ordinary descendants',async t=>{
  const f=await fixture(t),npm=join(f.bin,'npm');
  await writeFile(npm,"import {spawn} from 'node:child_process';process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});setInterval(()=>{},1000);");
  const config=RackConfig.parse({...f.config,packageTools:{...f.config.packageTools,node:process.execPath},packageTimeoutMs:100,packageKillGraceMs:25});
  await assert.rejects(new Packages(config).prepare(await f.revision()),{code:'PACKAGE_TIMEOUT'});
});

test('real package tool output is bounded and raw diagnostics never escape',async t=>{
  const f=await fixture(t),npm=join(f.bin,'npm');await writeFile(npm,"process.stderr.write('synthetic-package-secret'.repeat(1000));setInterval(()=>{},1000);");
  const config=RackConfig.parse({...f.config,packageTools:{...f.config.packageTools,node:process.execPath},maxObservationBytes:1024,packageKillGraceMs:25});
  await assert.rejects(new Packages(config).prepare(await f.revision()),error=>{assert(!String(error).includes('synthetic-package-secret'));return (error as {code:string}).code==='PACKAGE_OUTPUT';});
});

test('preparation timeout and live storage monitoring preserve responsive preview',async t=>{
  const f=await fixture(t,{packageTimeoutMs:25,monitorMs:1}),revision=await f.revision();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
  const packages=new Packages(f.config,request=>new Promise((_resolve,reject)=>{started();request.signal.addEventListener('abort',()=>reject(new Error('private abort detail')),{once:true});}));
  const work=packages.prepare(revision),check=assert.rejects(work,{code:'PACKAGE_TIMEOUT'});await ready;
  const preview=await f.connections.preview({configuration:{mcpServers:{server:{command:join(f.bin,'uvx'),args:['fixture@latest']}}}});assert.deepEqual(preview.errors,[]);await check;
});

test('compatible definitions reuse bytes while preserving independent launch arguments',async t=>{
  const f=await fixture(t),packages=new Packages(f.config,f.executor),first=await f.revision(),second=await f.revision('npx',['fixture@1.0.0','second-workspace'],'second');
  await Promise.all([packages.prepare(first),packages.prepare(second)]);assert.equal(f.calls,2);
  const a=await packages.resolve(first),b=await packages.resolve(second);assert.equal(a.installation.digest,b.installation.digest);assert.equal(a.args[0],b.args[0]);assert.deepEqual(b.args.slice(1),['second-workspace']);
});

test('shared package launches keep browser profiles and temporary files in each owner context',async t=>{
  const f=await fixture(t),revision=await f.revision('npx',['fixture@1.0.0','--user-data-dir','${POLARITON_RUNTIME}/profile']);assert.equal(revision.kind,'stdio');if(revision.kind!=='stdio')throw Error();
  revision.env={DATA:'${POLARITON_DATA}'};revision.requirements.storage={scope:'capability',access:'exclusive',retention:'retain'};
  await new Packages(f.config,f.executor).prepare(revision);
  const first=await f.connections.resolve(revision,'browser',{workspace:'/workspace-a',runtime:'/tmp/p-a',data:'/persistent-browser'}),second=await f.connections.resolve(revision,'browser',{workspace:'/workspace-b',runtime:'/tmp/p-b',data:'/persistent-browser'});
  assert('command' in first&&'command' in second);assert.equal(first.args[0],second.args[0]);assert.deepEqual(first.args.slice(1),['--user-data-dir','/tmp/p-a/profile']);assert.deepEqual(second.args.slice(1),['--user-data-dir','/tmp/p-b/profile']);
  const environment=(server:typeof first)=>Object.fromEntries(server.env.map(entry=>[entry.name,entry.value]));
  assert.equal(environment(first).HOME,'/tmp/p-a');assert.equal(environment(first).TMPDIR,'/tmp/p-a');assert.equal(environment(first).DATA,'/persistent-browser');assert.equal(environment(second).HOME,'/tmp/p-b');assert.equal(environment(second).TMPDIR,'/tmp/p-b');
  const overridden=await f.connections.resolve({...revision,env:{HOME:'${POLARITON_DATA}'}},'browser',{workspace:'/workspace',runtime:'/tmp/p-c',data:'/persistent-browser'});assert('command' in overridden);assert.equal(environment(overridden).HOME,'/persistent-browser');assert.equal(environment(overridden).TMPDIR,'/tmp/p-c');
});

test('registry source normalization is side-effect-free and does not depend on package runners',async t=>{
  const f=await fixture(t);await rm(join(f.bin,'npx'));await rm(join(f.bin,'uvx'));
  const {CapabilitySpec}=await import('../src/environment/preparation-contracts.ts');
  const specification=CapabilitySpec.parse({id:'fixture',name:'Fixture',source:{kind:'npm',identifier:'fixture',version:'1.0.0'},runtime:{kind:'local'},connection:{kind:'stdio'},requirements:{},authentication:{kind:'none'}});
  const normalized=await f.connections.source(specification);assert.equal(normalized.definition.kind,'stdio');if(normalized.definition.kind!=='stdio')throw Error();
  assert.equal(normalized.definition.command,'package:npm');assert.equal(normalized.definition.identity,undefined);assert.deepEqual(normalized.definition.package,{manager:'npm',specifier:'fixture@1.0.0',executable:'fixture'});
  await assert.rejects(readdir(f.config.stateRoot),{code:'ENOENT'});assert.equal(f.calls,0);
  await assert.rejects(f.connections.source({...specification,source:{kind:'npm',identifier:'fixture',version:'latest'}}),{code:'PACKAGE_VERSION'});
  await assert.rejects(f.connections.source(specification,undefined,{node:'/missing/proposed-node'}),{code:'PACKAGE_TOOL_MISSING'});
});

test('NuGet uses a private explicit tool installation and retains the selected version',async t=>{
  const f=await fixture(t),dotnet=join(f.bin,'dotnet');await writeFile(dotnet,'fixture',{mode:0o755});const config=RackConfig.parse({...f.config,packageTools:{...f.config.packageTools,dotnet}});
  const revision:ConnectionRevision={kind:'stdio',command:'package:nuget',args:['serve'],env:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'},package:{manager:'nuget',identifier:'Fixture.Server',version:'1.2.3'},id:'nuget',name:'NuGet',revisionId:'one',baseRevisionId:null,operationId:'one',createdAt:'2026-10-13T00:00:00Z'};
  const packages=new Packages(config,async request=>{if(request.args[0]==='--version')return '10.0.401';assert.equal(request.command,dotnet);assert(request.args.includes('--tool-path'));assert(!request.args.includes('--global'));assert(request.env.NUGET_PACKAGES?.startsWith(f.config.stateRoot));await writeFile(join(request.cwd,'fixture-server'),'fixture',{mode:0o755});return '';});
  await packages.prepare(revision);const result=await packages.resolve(revision);assert.deepEqual(result.args,['serve']);assert.deepEqual(result.installation.packages,[{name:'Fixture.Server',version:'1.2.3'}]);assert.equal(result.env.DOTNET_ROOT,f.bin);
});

test('Cargo native build authority is explicit and the dependency lock survives preparation',async t=>{
  const f=await fixture(t),cargo=join(f.bin,'cargo'),rustc=join(f.bin,'rustc');for(const path of [cargo,rustc])await writeFile(path,'fixture',{mode:0o755});const config=RackConfig.parse({...f.config,packageTools:{...f.config.packageTools,cargo,rustc}});
  const revision:ConnectionRevision={kind:'stdio',command:'package:cargo',args:['serve'],env:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'},package:{manager:'cargo',identifier:'fixture',version:'1.2.3'},id:'cargo',name:'Cargo',revisionId:'one',baseRevisionId:null,operationId:'one',createdAt:'2026-10-13T00:00:00Z'};
  let builds=0;const packages=new Packages(config,async request=>{if(request.args[0]==='--version')return 'cargo 1.99.0';builds++;assert(request.args.includes('--locked'));assert(request.args.includes('--root'));await mkdir(join(request.cwd,'bin'));await writeFile(join(request.cwd,'bin','fixture'),'binary',{mode:0o755});const source=join(request.env.CARGO_HOME!,'registry','src','fixture-registry','fixture-1.2.3');await mkdir(source,{recursive:true});await writeFile(join(source,'Cargo.lock'),'version = 4\n');return '';});
  await assert.rejects(packages.prepare(revision),{code:'PACKAGE_BUILD_AUTHORITY'});assert.equal(builds,0);
  revision.package={manager:'cargo',identifier:'fixture',version:'1.2.3',nativeBuild:true};await packages.prepare(revision);const result=await packages.resolve(revision);assert.equal(builds,1);assert.equal(await readFile(join(result.command,'..','..','Cargo.lock'),'utf8'),'version = 4\n');
});

test('cancelled preparation settles before the same selected artifact can retry',async t=>{
  const f=await fixture(t),revision=await f.revision(),controller=new AbortController();let entered!:()=>void;const started=new Promise<void>(done=>entered=done);
  const packages=new Packages(f.config,async request=>{if(request.args.at(-1)==='--version')return '24.0.0';if(request.args.includes('--package-lock-only'))return f.executor(request);entered();await new Promise<void>((_done,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('private cancellation detail')),{once:true}));return '';});
  const preparing=packages.prepare(revision,controller.signal),rejected=assert.rejects(preparing,{code:'PACKAGE_CANCELLED'});await started;controller.abort();await rejected;
  const restarted=new Packages(f.config,f.executor);await restarted.prepare(revision);assert.equal(f.calls,2);assert.equal((await restarted.resolve(revision)).installation.packages[0]!.version,'1.0.0');
});

test('uncertain interrupted effects stay visible and never trigger blind execution',async t=>{
  const f=await fixture(t),revision=await f.revision();let effects=0;
  const packages=new Packages(f.config,async request=>{effects++;await writeFile(request.effectPath!,JSON.stringify({state:'starting',pid:null}));throw new Error('interrupted effect');});
  await assert.rejects(packages.prepare(revision),{code:'PACKAGE_PREPARATION'});
  await assert.rejects(new Packages(f.config,async()=>{effects++;return '';}).prepare(revision),{code:'PACKAGE_CLEANUP_PENDING'});assert.equal(effects,1);
});

test('declared external identities and persistent data bindings remain part of package contracts',async t=>{
  const f=await fixture(t),dependency=join(f.root,'dependency');await writeFile(dependency,'original');
  const {CapabilitySpec}=await import('../src/environment/preparation-contracts.ts');const spec=CapabilitySpec.parse({id:'fixture',name:'Fixture',source:{kind:'npm',identifier:'fixture',version:'1.0.0'},runtime:{kind:'local'},connection:{kind:'stdio',args:['${POLARITON_DATA}']},requirements:{identityFiles:[dependency]},authentication:{kind:'none'}});
  await assert.rejects(f.connections.source(spec),{code:'STORAGE_UNDECLARED'});
  spec.requirements.storage={scope:'capability',access:'exclusive',retention:'retain'};const normalized=await f.connections.source(spec);assert.equal(normalized.definition.kind,'stdio');if(normalized.definition.kind!=='stdio')throw Error();assert.equal(normalized.definition.identity?.files[0]?.path,dependency);
  await writeFile(dependency,'changed');await assert.rejects(f.connections.prepare({...normalized.definition,id:'fixture',name:'Fixture',revisionId:'one',baseRevisionId:null,operationId:'one',createdAt:'2026-10-13T00:00:00Z'}),{code:'EXECUTABLE_DRIFT'});
});
