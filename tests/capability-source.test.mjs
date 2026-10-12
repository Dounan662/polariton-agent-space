import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,symlink,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import * as tar from 'tar';
import {ContainerBackend} from '../src/environment/backend.ts';
import {EnvironmentRack} from '../src/environment/rack.ts';
import {CapabilitySource,RackConfig,RackFault} from '../src/environment/contracts.ts';

const exec=promisify(execFile);
const manifest={format:1,name:'Workspace package',description:'Selected committed subtree',image:`node@sha256:${'1'.repeat(64)}`,build:[['node','build.mjs']],entrypoint:['node','server.mjs'],lockfiles:['package-lock.json'],configSchema:{type:'object'},mcpPath:'/mcp',port:8080,state:'scratch'};

/** Git and archive handling are real. The container boundary records requests and
 * returns a retained archive; package programs are never executed by this fixture. */
async function fixture(t,overrides={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-source-'))),repository=join(root,'workspace'),directory=join(repository,'capabilities','analysis');
  await mkdir(directory,{recursive:true});
  const git=async(...args)=>(await exec('git',['-C',repository,...args],{env:{...process.env,GIT_AUTHOR_DATE:'2001-02-03T04:05:06Z',GIT_COMMITTER_DATE:'2001-02-03T04:05:06Z'}})).stdout.trim();
  await git('init','--quiet');
  await writeFile(join(repository,'unrelated-secret.txt'),'This sibling must never enter the source snapshot');
  await writeFile(join(directory,'polariton-capability.json'),JSON.stringify(manifest));
  await writeFile(join(directory,'package-lock.json'),'{}');
  await writeFile(join(directory,'server.mjs'),'export const version = 1;\n');
  await writeFile(join(directory,'build.mjs'),`require('node:fs').writeFileSync(${JSON.stringify(join(root,'host-executed'))},'unsafe');`);
  const commit=async()=>{await git('add','.');await git('-c','user.name=Source test','-c','user.email=source@polariton.invalid','commit','--quiet','-m','Committed package');return git('rev-parse','HEAD');};
  const first=await commit();
  const config=RackConfig.parse({stateRoot:join(root,'state'),socketPath:join(root,'rack.sock'),monitorMs:3600000,...overrides});
  const calls=[];let buildSource,artifact;
  class BuildHost extends ContainerBackend{
    async ready(){}
    async owned(){return [];}
    async docker(args){
      calls.push(args);
      if(args[0]==='pull'||args[0]==='start'||args[0]==='rm')return Buffer.alloc(0);
      if(args[0]==='image')return Buffer.from(JSON.stringify('sha256:fixture'));
      if(args[0]==='create'){
        const mount=args.find(value=>value.startsWith('type=bind,src='));
        buildSource=mount.slice('type=bind,src='.length).split(',dst=')[0];
        return Buffer.from('build-container');
      }
      if(args[0]==='exec'&&args.includes('tar'))return artifact??readFile(join(dirname(buildSource),'source.tar'));
      if(args[0]==='exec')return Buffer.from('simulated isolated build');
      throw new Error(`Unexpected container request ${JSON.stringify(args)}`);
    }
  }
  const backend=new BuildHost(config,'fixture-owner');
  let rack=await new EnvironmentRack(config,()=>backend).open();
  t.after(async()=>{await rack.close();await rm(root,{recursive:true,force:true});});
  const register=(path=directory,id='package')=>rack.execute({kind:'capability.register',operationId:`register-${id}`,id,repository:path});
  const install=(id='release',sha=first,packageId='package')=>rack.execute({kind:'release.install',operationId:id,packageId,commit:sha});
  return {root,repository,directory,git,commit,first,config,calls,backend,register,install,
    get rack(){return rack;},set artifact(bytes){artifact=bytes;},
    async reopen(){await rack.close();rack=await new EnvironmentRack(config,()=>backend).open();},
  };
}

test('workspace package source resolves internally and immutable installation excludes siblings and working changes',async t=>{
  const f=await fixture(t),capability=await f.register();
  const source={repository:f.repository,subdirectory:'capabilities/analysis'};
  assert.deepEqual(capability.source,source);
  assert.deepEqual(await f.rack.execute({kind:'capability.register',operationId:'duplicate',repository:f.directory}),capability);
  await writeFile(join(f.directory,'server.mjs'),'export const version = 2;\n');
  await writeFile(join(f.directory,'untracked.txt'),'Never installed');
  const installed=await f.install();
  assert.deepEqual(installed.source,source);assert.equal(installed.commit,f.first);
  const retained=join(f.config.stateRoot,'releases',installed.id);
  assert.equal(await readFile(join(retained,'artifact','server.mjs'),'utf8'),'export const version = 1;\n');
  assert.deepEqual((await readdir(join(retained,'artifact'))).sort(),['build.mjs','package-lock.json','polariton-capability.json','server.mjs']);
  assert.deepEqual((await f.rack.provenance(installed.id)).source,source);
  await assert.rejects(access(join(f.root,'host-executed')),{code:'ENOENT'});
  assert(f.calls.some(args=>args.includes('node')&&args.includes('build.mjs')),'Build argv reaches only the container boundary');
  const calls=f.calls.length;await f.reopen();
  assert.deepEqual(await f.install(),installed);assert.equal(f.calls.length,calls,'Recovery does not rebuild an installed release');
  assert.deepEqual(f.rack.capability(capability.id).source,source);
});

test('standalone repository root preserves the same registration and build contract',async t=>{
  const f=await fixture(t);
  for(const name of ['polariton-capability.json','package-lock.json','server.mjs','build.mjs'])await writeFile(join(f.repository,name),await readFile(join(f.directory,name)));
  const commit=await f.commit(),registered=await f.register(f.repository,'standalone');
  assert.deepEqual(registered.source,{repository:f.repository,subdirectory:''});
  const release=await f.install('root-release',commit,'standalone');
  assert.equal(release.source.subdirectory,'');
  const archive=join(f.config.stateRoot,'releases','root-release','source.tar');
  assert.deepEqual(await readFile(archive),(await exec('git',['-C',f.repository,'archive','--format=tar',commit],{encoding:'buffer'})).stdout);
  const mtimes=[];await tar.t({file:archive,onReadEntry:entry=>mtimes.push(entry.mtime?.getTime())});
  const timestamp=Number(await f.git('show','--no-patch','--format=%ct',commit))*1000;
  assert(mtimes.length>0);assert(mtimes.every(value=>value===timestamp));
  assert.equal(await readFile(join(f.config.stateRoot,'releases','root-release','artifact','unrelated-secret.txt'),'utf8'),'This sibling must never enter the source snapshot');
});

test('subtree source archives use commit timestamps and remain byte-identical across independent releases',async t=>{
  const f=await fixture(t);await f.register();
  await f.install('first-snapshot');await f.install('second-snapshot');
  const first=join(f.config.stateRoot,'releases','first-snapshot','source.tar'),second=join(f.config.stateRoot,'releases','second-snapshot','source.tar');
  assert.deepEqual(await readFile(first),await readFile(second));
  const timestamp=Number(await f.git('show','--no-patch','--format=%ct',f.first))*1000;
  assert.equal(timestamp,Date.parse('2001-02-03T04:05:06Z'));
  const mtimes=[];await tar.t({file:first,onReadEntry:entry=>mtimes.push(entry.mtime?.getTime())});
  assert(mtimes.length>0);assert(mtimes.every(value=>value===timestamp));
  assert.equal((await f.rack.provenance('first-snapshot')).sourceDigest,(await f.rack.provenance('second-snapshot')).sourceDigest);
});

test('source identity rejects traversal and registration rejects symlink directories and submodule roots',async t=>{
  const f=await fixture(t);
  for(const subdirectory of ['../escape','a/../b','/absolute','a\\b','.git','a//b'])assert.equal(CapabilitySource.safeParse({repository:f.repository,subdirectory}).success,false);
  await symlink(f.directory,join(f.repository,'alias'));
  await assert.rejects(f.register(join(f.repository,'alias'),'alias'),{code:'SOURCE_DIRECTORY'});
  await symlink(join(f.repository,'capabilities'),join(f.repository,'redirected-parent'));
  await assert.rejects(f.register(join(f.repository,'redirected-parent','analysis'),'parent-link'),{code:'SOURCE_DIRECTORY'});
  const other=join(f.root,'other');await exec('git',['clone','--quiet',f.repository,other]);
  await f.git('-c','protocol.file.allow=always','submodule','add','--quiet',other,'nested');
  await assert.rejects(f.register(join(f.repository,'nested'),'nested'),{code:'SOURCE_SUBMODULE'});
  assert.deepEqual(f.calls,[],'Registration never prepares a container');
});

test('committed symlinks and gitlinks inside the package reject before a container is created',async t=>{
  const f=await fixture(t);await f.register();
  await symlink('../../unrelated-secret.txt',join(f.directory,'link'));
  const symlinkCommit=await f.commit();
  await assert.rejects(f.install('symlink-release',symlinkCommit),{code:'SOURCE_TREE'});
  await rm(join(f.directory,'link'));await f.git('add','.');
  await f.git('update-index','--add','--cacheinfo',`160000,${f.first},capabilities/analysis/submodule`);
  await f.git('-c','user.name=Source test','-c','user.email=source@polariton.invalid','commit','--quiet','-m','Gitlink');
  await assert.rejects(f.install('submodule-release',await f.git('rev-parse','HEAD')),{code:'SOURCE_TREE'});
  assert.deepEqual(f.calls,[]);
});

test('a sibling symlink is outside the selected package and does not block installation',async t=>{
  const f=await fixture(t);await symlink('/outside',join(f.repository,'sibling-link'));
  const commit=await f.commit();await f.register();
  assert.equal((await f.install('release',commit)).commit,commit);
});

test('source selection must exist as a tree at the exact commit and archive attributes cannot omit committed files',async t=>{
  const f=await fixture(t);await f.register();
  await assert.rejects(f.install('unknown','0'.repeat(40)));
  const absent={repository:f.repository,subdirectory:'uncommitted'};
  await mkdir(join(f.repository,'uncommitted'));
  await assert.rejects(f.backend.install(absent,f.first,'absent'));
  await assert.rejects(f.backend.install({...absent,subdirectory:'unrelated-secret.txt'},f.first,'file'));
  await writeFile(join(f.directory,'.gitattributes'),'server.mjs export-ignore\n');
  await assert.rejects(f.install('omitted',await f.commit()),{code:'SOURCE_ARCHIVE'});
  assert.deepEqual(f.calls,[]);
});

test('mutable Git replacement refs cannot change exact committed package bytes',async t=>{
  const f=await fixture(t);await f.register();
  await writeFile(join(f.directory,'server.mjs'),'replacement contents');
  const replacement=await f.commit();await f.git('replace',f.first,replacement);
  await f.install();
  assert.equal(await readFile(join(f.config.stateRoot,'releases','release','artifact','server.mjs'),'utf8'),'export const version = 1;\n');
});

test('source entry and byte budgets reject before build dispatch',async t=>{
  for(const bounds of [{maxArchiveEntries:2},{maxSourceBytes:128}]){
    const f=await fixture(t,bounds);await f.register();
    await assert.rejects(f.install(),error=>['SOURCE_LIMIT','OUTPUT_LIMIT'].includes(error.code));
    assert.deepEqual(f.calls,[]);
  }
});

test('build and retained-release capacity reserve before shared runtime startup and recover after readiness failure',async t=>{
  for(const [bounds,code] of [[{maxInstalls:1,maxReleases:2},'INSTALL_CAPACITY'],[{maxInstalls:2,maxReleases:1},'RELEASE_CAPACITY']]){
    const f=await fixture(t,bounds);await f.register();await f.register(f.repository,'workspace');
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    f.backend.ready=async()=>{entered.resolve();await release.promise;};
    const first=f.install();await entered.promise;
    try{await assert.rejects(f.install('second',f.first,'workspace'),{code});}finally{release.resolve();}
    await first;
  }
  const f=await fixture(t,{maxInstalls:1});await f.register();
  f.backend.ready=async()=>{throw new RackFault('RUNTIME_START_FAILED','Controlled startup failure');};
  await assert.rejects(f.install(),{code:'RUNTIME_START_FAILED'});
  f.backend.ready=async()=>{};
  assert.equal((await f.install()).id,'release','Failed readiness releases the reservation for explicit retry');
});

test('one Apply shares a failed runtime preparation across components without automatically retrying startup',async t=>{
  const f=await fixture(t);await f.register();await f.install();
  await f.rack.execute({kind:'environment.publish',operationId:'revision',expectedBase:null,document:{format:2,environmentId:'environment',name:'Two tools',description:'',components:['one','two'].map(id=>({id,name:id,releaseId:'release',configuration:{}}))}});
  let starts=0;
  f.backend.ready=async options=>{assert.equal(options.start,true);starts++;throw new RackFault('RUNTIME_START_UNCERTAIN','Startup may continue; inspect the configured profile');};
  const request={kind:'environment.apply',operationId:'apply',environmentId:'environment',revisionId:'revision'};
  const first=await f.rack.execute(request);
  assert.equal(first.status,'partial');assert.equal(starts,1);
  assert.equal(first.components.length,2);assert(first.components.every(value=>value.errorCode==='RUNTIME_START_UNCERTAIN'));
  assert.equal(f.rack.operation('apply').state,'partial');
  const retry=await f.rack.execute(request);
  assert.equal(starts,2,'Only an explicit retry starts a new preparation attempt');
  assert.deepEqual(retry.components,first.components);
});

test('artifact archives cannot publish symlinks',async t=>{
  const f=await fixture(t);await f.register();
  const malicious=join(f.root,'malicious');await mkdir(malicious);await symlink('/outside',join(malicious,'link'));
  const path=join(f.root,'artifact.tar');await tar.c({file:path,cwd:malicious},['link']);f.artifact=await readFile(path);
  await assert.rejects(f.install(),{code:'ARCHIVE_INVALID'});
  await assert.rejects(access(join(f.config.stateRoot,'releases','release','artifact')),{code:'ENOENT'});
  assert(f.calls.some(args=>args[0]==='rm'),'Failed builds release the container');
});


test('artifact traversal, duplicate destinations and expanded-byte excess reject before publication',async t=>{
  for(const attack of ['traversal','duplicate','expanded']){
    const f=await fixture(t,attack==='expanded'?{maxArtifactBytes:4096}:{});await f.register();
    const entry=(path,size=1)=>{
      const header=new tar.Header({path,type:'File',mode:0o644,size,mtime:new Date(0)});header.encode();
      return Buffer.concat([header.block,Buffer.alloc(Math.ceil(size/512)*512)]);
    };
    // A compressed archive's retained bytes can fit while extraction exceeds the bound.
    if(attack==='expanded'){
      await writeFile(join(f.root,'huge'),Buffer.alloc(8192));
      const compressed=join(f.root,'expanded.tar.gz');await tar.c({file:compressed,cwd:f.root,gzip:true},['huge']);
      f.artifact=await readFile(compressed);
    }else f.artifact=Buffer.concat([entry(attack==='traversal'?'../escape':'same'),...(attack==='duplicate'?[entry('same')]:[]),Buffer.alloc(1024)]);
    await assert.rejects(f.install());
    await assert.rejects(access(join(f.config.stateRoot,'releases','release','artifact')),{code:'ENOENT'});
    await assert.rejects(access(join(f.config.stateRoot,'staging','release','escape')),{code:'ENOENT'});
  }
});
