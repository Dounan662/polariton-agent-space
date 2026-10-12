import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionHost} from '../src/host-support.ts';
import {nativePickerAvailability} from '../src/directory-picker.ts';

test('execution profiles require the exact implemented OS and architecture',()=>{
  assert.equal(executionHost({platform:'darwin',architecture:'arm64'}),'macos-arm64');
  assert.equal(executionHost({platform:'linux',architecture:'x64',osRelease:'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n'}),'ubuntu-24.04-amd64');
  assert.equal(executionHost({platform:'linux',architecture:'x64',osRelease:'ID=ubuntu\nVERSION_ID=26.04\n'}),'ubuntu-26.04-amd64');
  for(const host of [
    {platform:'linux',architecture:'arm64',osRelease:'ID=ubuntu\nVERSION_ID="24.04"'},
    {platform:'linux',architecture:'x64',osRelease:'ID=debian\nID_LIKE=ubuntu\nVERSION_ID="24.04"'},
    {platform:'linux',architecture:'x64',osRelease:'ID=ubuntu\nVERSION_ID="22.04"'},
    {platform:'linux',architecture:'x64',osRelease:'ID=ubuntu\nVERSION_ID=26.10'},
    {platform:'linux',architecture:'arm64',osRelease:'ID=ubuntu\nVERSION_ID=26.04'},
    {platform:'linux',architecture:'x64'}, {platform:'darwin',architecture:'x64'},
  ])assert.throws(()=>executionHost(host),{code:'HOST_UNSUPPORTED'});
});

test('headless directory entry needs neither display tools nor a graphical probe',async()=>{
  const io={platform:'linux',env:{PATH:'/usr/bin'},executable:async()=>{throw new Error('Headless availability must not inspect desktop programs');}};
  const result=await nativePickerAvailability(io);assert.equal(result.available,false);
  assert.match(result.available?'':result.reason,/no graphical display/);
});

test('native chooser capability requires an absolute executable search path on Linux',async()=>{
  const inspected:string[]=[];
  const io={platform:'linux',env:{DISPLAY:':0',PATH:'.:/usr/bin'},executable:async(path:string)=>{inspected.push(path);return path==='/usr/bin/kdialog';}};
  assert.deepEqual(await nativePickerAvailability(io),{available:true});
  assert(inspected.every(path=>path.startsWith('/usr/bin/')));
  assert.equal((await nativePickerAvailability({...io,executable:async()=>false})).available,false);
});
