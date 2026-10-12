import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {applicationPaths,checkLegacyStorage} from '../src/paths.ts';
import {loadConfig,sourceRoot} from '../src/config.ts';
import {loadRackConfig} from '../src/environment/daemon.ts';
import {temporaryDirectory} from './fixtures/storage.ts';

test('macOS and Linux defaults separate data, configuration, cache and runtime from code',()=>{
  const mac=applicationPaths({platform:'darwin',home:'/example/home',uid:501,env:{}});
  assert.equal(mac.data,'/example/home/Library/Application Support/Polariton/data');
  assert.equal(mac.config,'/example/home/Library/Application Support/Polariton/config');
  assert.equal(mac.cache,'/example/home/Library/Caches/Polariton');
  assert.match(mac.runtime,/^\/tmp\/polariton-501\/[a-f0-9]{16}$/);
  const linux=applicationPaths({platform:'linux',home:'/home/researcher',uid:1000,env:{}});
  assert.equal(linux.data,'/home/researcher/.local/share/polariton/data');
  assert.equal(linux.config,'/home/researcher/.config/polariton');
  assert.equal(linux.cache,'/home/researcher/.cache/polariton');
  assert.equal(linux.state,'/home/researcher/.local/state/polariton');
});

test('Linux honors XDG roots and ignores relative XDG values',()=>{
  const paths=applicationPaths({platform:'linux',home:'/home/researcher',uid:1000,env:{
    XDG_DATA_HOME:'/data',XDG_CONFIG_HOME:'/configuration',XDG_CACHE_HOME:'/cache',XDG_STATE_HOME:'/state',XDG_RUNTIME_DIR:'/run/user/1000',
  }});
  assert.equal(paths.data,'/data/polariton/data');assert.equal(paths.config,'/configuration/polariton');
  assert.equal(paths.cache,'/cache/polariton');assert.equal(paths.state,'/state/polariton');assert.match(paths.runtime,/^\/run\/user\/1000\/polariton\/[a-f0-9]{16}$/);
  const invalid=applicationPaths({platform:'linux',home:'/home/researcher',uid:1000,env:{XDG_DATA_HOME:'relative',XDG_RUNTIME_DIR:'relative'}});
  assert.equal(invalid.data,'/home/researcher/.local/share/polariton/data');assert.match(invalid.runtime,/^\/tmp\/polariton-1000\/[a-f0-9]{16}$/);
  const other=applicationPaths({platform:'linux',home:'/home/researcher',uid:1000,env:{XDG_DATA_HOME:'/other-data',XDG_RUNTIME_DIR:'/run/user/1000'}});
  assert.notEqual(other.runtime,paths.runtime);
});

test('development and explicit data roots isolate persistent data and daemon sockets',()=>{
  for(const platform of ['darwin','linux'] as const){
    const options={platform,home:'/home/researcher',uid:1000};
    const production=applicationPaths({...options,env:{}}),development=applicationPaths({...options,env:{POLARITON_PROFILE:'development'}});
    for(const key of ['data','config','cache','state','runtime','releases'] as const)assert.notEqual(production[key],development[key]);
    const first=applicationPaths({...options,env:{POLARITON_DATA_DIR:'/disposable/one'}});
    const second=applicationPaths({...options,env:{POLARITON_DATA_DIR:'/disposable/two'}});
    assert.equal(first.data,'/disposable/one');assert.notEqual(first.runtime,second.runtime);
    assert.equal(first.runtime,applicationPaths({...options,env:{POLARITON_DATA_DIR:'/disposable/one'}}).runtime);
  }
  assert.throws(()=>applicationPaths({env:{POLARITON_DATA_DIR:'relative'}}),/absolute/);
  assert.throws(()=>applicationPaths({env:{POLARITON_PROFILE:'typo'}}),/production or development/);
});

test('daemon loaders share default locations while explicit file paths retain precedence',async t=>{
  const paths=applicationPaths(),app=await loadConfig(),rack=await loadRackConfig();
  assert.equal(app.stateRoot,join(paths.data,'app'));assert.equal(app.runtimeDirectory,paths.runtime);
  assert.equal(rack.stateRoot,join(paths.data,'environment'));assert.equal(rack.socketPath,join(paths.runtime,'environment.sock'));
  assert.equal(rack.dockerConfig,join(rack.stateRoot,'docker'));
  assert.equal(rack.runtime.kind,process.platform==='darwin'?'colima':'external');
  const directory=await temporaryDirectory('polariton-config-');t.after(()=>rm(directory,{recursive:true,force:true}));
  const document=JSON.parse(await readFile(join(sourceRoot,'config/app.json'),'utf8'));
  await writeFile(join(directory,'app.json'),JSON.stringify({...document,stateRoot:'retained-app',runtimeDirectory:'run',sharedSkillsDir:'skills'}));
  await writeFile(join(directory,'environment.json'),JSON.stringify({stateRoot:'retained-environment',socketPath:'run/env.sock',dockerConfig:'docker',runtime:{kind:'external'}}));
  const retained=await loadConfig(join(directory,'app.json')),environment=await loadRackConfig(join(directory,'environment.json'));
  assert.equal(retained.stateRoot,join(directory,'retained-app'));assert.equal(retained.runtimeDirectory,join(directory,'run'));
  assert.equal(retained.sharedSkillsDir,join(directory,'skills'));assert.equal(environment.stateRoot,join(directory,'retained-environment'));
  assert.equal(environment.socketPath,join(directory,'run/env.sock'));assert.equal(environment.dockerConfig,join(directory,'docker'));
  assert.equal(environment.dockerSocket,undefined);
  await writeFile(join(directory,'external.json'),JSON.stringify({stateRoot:'existing-rack',socketPath:'run/external.sock',dockerContext:'retained-context'}));
  const external=await loadRackConfig(join(directory,'external.json'));
  assert.equal(external.runtime.kind,'external');assert.equal(external.dockerContext,'retained-context');
  assert.equal(external.dockerConfig,undefined);assert.equal(external.dockerSocket,undefined);
});

test('a changed default requires an explicit choice when legacy data exists and preserves it',async t=>{
  const directory=await temporaryDirectory('polariton-legacy-');t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'research'),'retained');
  await assert.rejects(checkLegacyStorage(directory),/Existing Polariton data preserved.*stateRoot/);
  assert.equal(await readFile(join(directory,'research'),'utf8'),'retained');
  await checkLegacyStorage(join(directory,'absent'));
});
