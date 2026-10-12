import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {CanvasSnapshots} from '../src/canvas-snapshots.ts';
import {CanvasPolicy,type CanvasSnapshot} from '../src/canvas-contracts.ts';

const scope={actor:'worker:one',project:'research'},other={actor:'worker:two',project:'research'};
const bytes=Buffer.from('validated PNG from the adjacent bridge');
const snapshot:CanvasSnapshot={canvas:'browser',project:'research',revision:'layout',graphRevision:1,mediaType:'image/png',width:100,height:100,bounds:{x:0,y:0,width:100,height:100},data:bytes.toString('base64'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
async function fixture(t:TestContext,overrides:Partial<CanvasPolicy>={},now=Date.now){
 const root=await realpath(await mkdtemp(join(tmpdir(),'canvas-cache-test-'))),policy=CanvasPolicy.parse(overrides),errors:unknown[]=[];
 const cache=await CanvasSnapshots.open(root,policy,error=>errors.push(error),{temporaryRoot:root,now});
 t.after(async()=>{await cache.close();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 return {cache,root,policy,errors};
}

test('private temporary files remain available for comparison until scoped, repeatable finish',async t=>{
 const {cache}=await fixture(t),first=await cache.capture(scope,async()=>snapshot),second=await cache.capture(scope,async()=>snapshot);
 const theirs=await cache.capture(other,async()=>snapshot),otherProject=await cache.capture({...scope,project:'other'},async()=>snapshot);
 assert.notEqual(first.output,second.output);assert.deepEqual(await readFile(first.output),bytes);assert.equal((await stat(first.output)).mode&0o777,0o600);assert.equal((await stat(dirname(first.output))).mode&0o777,0o700);
 assert.equal('data' in first,false);assert.equal(typeof first.expiresAt,'number');
 assert.deepEqual(await cache.finish({project:scope.project,actor:scope.actor}),{removed:2});assert.deepEqual(await cache.finish(scope),{removed:0});
 await assert.rejects(readFile(first.output),{code:'ENOENT'});await assert.rejects(readFile(second.output),{code:'ENOENT'});
 assert.deepEqual(await readFile(theirs.output),bytes);assert.deepEqual(await readFile(otherProject.output),bytes);
 await cache.close();await assert.rejects(readFile(theirs.output),{code:'ENOENT'});
});

test('capacity includes in-flight captures; finish cancels and prevents late publication',async t=>{
 const {cache}=await fixture(t,{maxSnapshots:1});
 let complete!:(image:CanvasSnapshot)=>void,started!:()=>void,signal!:AbortSignal;
 const ready=new Promise<void>(resolve=>started=resolve);
 const pending=cache.capture(scope,s=>{signal=s;started();return new Promise(resolve=>complete=resolve);});
 const rejected=assert.rejects(pending,{code:'CANVAS_CANCELLED'});await ready;
 await assert.rejects(cache.capture(other,async()=>snapshot),{code:'CANVAS_LIMIT'});
 assert.deepEqual(await cache.finish(scope),{removed:0});assert.equal(signal.aborted,true);
 complete(snapshot);await rejected;
 const retained=await cache.capture(scope,async()=>snapshot);
 await assert.rejects(cache.capture(other,async()=>snapshot),{code:'CANVAS_LIMIT'});assert.deepEqual(await readFile(retained.output),bytes);
});

test('failed and caller-cancelled captures release capacity without leaving files',async t=>{
 const {cache}=await fixture(t,{maxSnapshots:1});
 await assert.rejects(cache.capture(scope,async()=>{throw new Error('Browser disconnected');}),/Browser disconnected/);
 const abort=new AbortController();abort.abort();
 await assert.rejects(cache.capture(scope,async()=>{assert.fail('Cancelled capture must not render');},abort.signal),{code:'CANVAS_CANCELLED'});
 assert.deepEqual(await cache.finish(scope),{removed:0});assert.ok((await cache.capture(other,async()=>snapshot)).output);
});

test('oversized captures release their reserved capacity without creating a file',async t=>{
 const {cache}=await fixture(t,{maxSnapshots:1,maxImageBytes:bytes.length});
 await assert.rejects(cache.capture(scope,async()=>({...snapshot,data:Buffer.alloc(bytes.length+1).toString('base64')})),{code:'CANVAS_LIMIT'});
 assert.deepEqual(await cache.finish(scope),{removed:0});assert.deepEqual(await readFile((await cache.capture(scope,async()=>snapshot)).output),bytes);
});

test('expiry removes images without another caller and permits new captures',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const {cache}=await fixture(t,{snapshotTtlMs:100,maxSnapshots:1},()=>Date.now());
 const image=await cache.capture(scope,async()=>snapshot);assert.equal(image.expiresAt,1100);
 t.mock.timers.tick(99);assert.deepEqual(await readFile(image.output),bytes);
 t.mock.timers.tick(1);await cache.finish(other); // Wait behind the expiry callback's public owner queue.
 await assert.rejects(readFile(image.output),{code:'ENOENT'});assert.ok((await cache.capture(scope,async()=>snapshot)).output);
});

test('restart discovers an interrupted process image and expires it without a database',async t=>{
 const {root,policy}=await fixture(t,{snapshotTtlMs:100});
 const program=`import {CanvasSnapshots} from ${JSON.stringify(new URL('../src/canvas-snapshots.ts',import.meta.url).href)};
 const cache=await CanvasSnapshots.open(process.argv[1],JSON.parse(process.argv[2]),error=>{throw error;},{temporaryRoot:process.argv[1],now:()=>1000});
 console.log(JSON.stringify(await cache.capture(${JSON.stringify(scope)},async()=>(${JSON.stringify(snapshot)}))));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',program,root,JSON.stringify(policy)],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);const image=JSON.parse(child.stdout);assert.deepEqual(await readFile(image.output),bytes);
 const restarted=await CanvasSnapshots.open(root,policy,error=>{throw error;},{temporaryRoot:root,now:()=>1100});
 await assert.rejects(readFile(image.output),{code:'ENOENT'});await restarted.close();
});

test('cache rejects redirected directories without touching their target',async t=>{
 const {root,cache,policy}=await fixture(t),image=await cache.capture(scope,async()=>snapshot),directory=dirname(image.output),protectedFile=join(root,'keep.txt');
 await cache.close();await rm(directory,{recursive:true});await writeFile(protectedFile,'keep');await symlink(root,directory);
 await assert.rejects(CanvasSnapshots.open(root,policy,()=>{},{temporaryRoot:root}),{code:'CANVAS_STORAGE'});assert.equal(await readFile(protectedFile,'utf8'),'keep');
});

test('cleanup failures are observable and recover on bounded expiry retry',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const {cache,errors}=await fixture(t,{snapshotTtlMs:100},()=>Date.now()),image=await cache.capture(scope,async()=>snapshot);
 await rm(image.output);await mkdir(image.output);
 await assert.rejects(cache.finish(scope),{code:'CANVAS_STORAGE'});
 t.mock.timers.tick(100);await cache.finish(other);assert.equal(errors.length,1);assert.equal((errors[0] as {code:string}).code,'CANVAS_STORAGE');
 errors.length=0;await rm(image.output,{recursive:true});await writeFile(image.output,bytes);
 t.mock.timers.tick(100);await cache.finish(other);await assert.rejects(readFile(image.output),{code:'ENOENT'});
 assert.deepEqual(await cache.finish(scope),{removed:0});
});
