import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceFolder} from '../src/workspace-folder.ts';

const limits={timeoutMs:1000,maxOutputBytes:4096};
const signal=()=>new AbortController().signal;
test('opens the exact workspace as one argument on macOS and Ubuntu desktops',async()=>{
 for(const [platform,env,command] of [['darwin',{},'/usr/bin/open'],['linux',{DISPLAY:':0'},'xdg-open'],['linux',{WAYLAND_DISPLAY:'wayland-0'},'xdg-open']] as const){
  const calls:unknown[]=[];
  const folder=new WorkspaceFolder(limits,{platform,env,run:async(cmd,args)=>{calls.push([cmd,args]);}});
  await folder.open('/research/a folder; $(echo unsafe)',signal());
  assert.deepEqual(calls,[[command,['/research/a folder; $(echo unsafe)']]]);
 }
});
test('headless and unsupported hosts never launch; failures allow a later retry',async()=>{
 for(const platform of ['linux','win32']){
  const folder=new WorkspaceFolder(limits,{platform,env:{},run:async()=>assert.fail('must not launch')});
  await assert.rejects(folder.open('/workspace',signal()),{code:'FOLDER_UNAVAILABLE'});
 }
 let fail=true;
 const folder=new WorkspaceFolder(limits,{platform:'linux',env:{DISPLAY:':0'},run:async()=>{if(fail)throw new Error('xdg-open unavailable');}});
 await assert.rejects(folder.open('/workspace',signal()),(error:unknown)=>{
  assert.ok(error instanceof Error);assert.match(error.message,/Check that the folder exists/);
  assert.doesNotMatch(error.message,/xdg-open unavailable/);assert.match(String(error.cause),/xdg-open unavailable/);return true;
 });
 fail=false;await folder.open('/workspace',signal());
 await assert.rejects(folder.open('relative',signal()),{code:'FOLDER_PATH'});
});
test('launch ownership handles overlap, cancellation, shutdown and deadline recovery',async()=>{
 const host={platform:'darwin',env:{},run:async(_cmd:string,_args:string[],options:{signal:AbortSignal})=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))};
 const folder=new WorkspaceFolder(limits,host),controller=new AbortController();
 const first=folder.open('/workspace',controller.signal);
 await assert.rejects(folder.open('/workspace',signal()),{code:'FOLDER_BUSY'});
 controller.abort(new Error('disconnected'));await assert.rejects(first,/disconnected/);
 const next=folder.open('/workspace',signal());folder.close();await assert.rejects(next,{code:'SHUTTING_DOWN'});
 await assert.rejects(folder.open('/workspace',signal()),{code:'SHUTTING_DOWN'});
 const timed=new WorkspaceFolder({...limits,timeoutMs:5},host);
 await assert.rejects(timed.open('/workspace',signal()),{code:'FOLDER_TIMEOUT'});
 await assert.rejects(timed.open('/workspace',signal()),{code:'FOLDER_TIMEOUT'});
});

test('missing Linux opener gives actionable advice without exposing process diagnostics',async()=>{
 const cause=Object.assign(new Error('spawn xdg-open ENOENT; private command details'),{code:'ENOENT'});
 const folder=new WorkspaceFolder(limits,{platform:'linux',env:{DISPLAY:':0'},run:async()=>{throw cause;}});
 await assert.rejects(folder.open('/workspace',signal()),(error:unknown)=>{
  assert.ok(error instanceof Error);assert.match(error.message,/Install xdg-utils/);assert.doesNotMatch(error.message,/private/);assert.equal(error.cause,cause);return true;
 });
});
