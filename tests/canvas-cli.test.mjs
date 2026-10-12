import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadConfig} from '../src/config.ts';
import {parseArguments,parseInvocation} from '../src/cli/client.ts';
import {CallerAccess,serveApplication} from '../src/cli/server.ts';
import {discovery} from '../src/cli/contracts.ts';
import {helpOutput} from '../src/cli/help.ts';
import {Fault} from '../src/contracts.ts';

const project='11111111-1111-4111-8111-111111111111',canvas='22222222-2222-4222-8222-222222222222',node='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444';
const base=['--project',project,'--canvas',canvas],move=[...base,'--expect-revision','layout-1','--request-id',requestId];
const parse=(args,input)=>{const {words,flags}=parseArguments(args);return parseInvocation(words,flags,input).request;};
const help=args=>{const {words,flags}=parseArguments([...args,'--help','--json']);return JSON.parse(helpOutput(words,flags)).data;};

test('canvas positioning normalizes single and batch edits and preserves presentation identity',()=>{
 const single=parse(['canvas','move',node,...move,'--x','-25.5','--y','240']);
 assert.deepEqual(single,{version:1,requestId,command:{kind:'canvas.move',input:{project,canvas,expectRevision:'layout-1',positions:[{id:node,x:-25.5,y:240}]}}});
 assert.deepEqual(parse(['canvas','move',...move,'--input','-'],{positions:[{id:node,x:-25.5,y:240}]}),single);
 assert.throws(()=>parse(['canvas','move',node,...move,'--x','1','--y','2'],{positions:[{id:node,x:1,y:2}]}),/not both/);
 for(const args of [[node,...move,'--x','1'],[...move,'--x','1','--y','2'],[node,...move,'--x','NaN','--y','2'],[node,...move,'--x','Infinity','--y','2']])assert.throws(()=>parse(['canvas','move',...args]));
 assert.throws(()=>parse(['canvas','move',...move],{positions:[{id:node,x:1,y:2},{id:node,x:3,y:4}]}),/once/);
 assert.throws(()=>parse(['canvas','move',node,...base,'--expect-revision','layout-1','--x','1','--y','2']),/request-id/);
 assert.throws(()=>parse(['canvas','move',node,...move,'--x','1','--y','2','--wait']),/receipt/);
 assert.throws(()=>parse(['canvas','move',node,...move,'--x','1','--y','2','--details']),/receipts/);
 assert.equal(parse(['canvas','snapshot',...base]).command.kind,'canvas.snapshot');
 const finish=parse(['canvas','finish','--project',project]);assert.equal(finish.requestId,undefined);assert.deepEqual(finish.command,{kind:'canvas.finish',input:{project}});
 assert.throws(()=>parse(['canvas','finish','--project',project,'--wait']),/receipt/);
 assert.throws(()=>parse(['canvas','snapshot','--project',project,'--output','graph.png']),/canvas/);
 assert.equal(parse(['canvas','get','--project',project]).command.input.canvas,undefined);
});

test('canvas discovery describes temporary snapshot lifecycle and optional export',()=>{
 const move=help(['canvas','move']);assert(!move.clientInputs.some(v=>v.name==='--wait'||v.name==='--details'));
 assert(move.clientInputs.some(v=>v.name==='--x'));assert(move.clientInputs.some(v=>v.name==='--request-id'&&v.required));
 assert.equal(help(['canvas','snapshot']).clientInputs.find(v=>v.name==='--output').required,false);
 assert(!help(['canvas','finish']).clientInputs.some(v=>['--request-id','--wait','--details'].includes(v.name)));
 assert.equal(discovery('canvas.move').commands['canvas.move'].presentation,undefined);
 assert.equal(discovery('canvas.move').commands['canvas.move'].mutation,true);
});

/** Real executable and authenticated transport surround a controlled presentation owner.
 * Browser rendering and edit arbitration are exercised at their own boundaries. */
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'canvas-cli-')),configPath=join(root,'app.json');
 const config={...await loadConfig(),configPath,stateRoot:join(root,'state'),verification:false};await mkdir(config.stateRoot);await writeFile(configPath,JSON.stringify(config));
 const access=new CallerAccess(config);await access.initialize();const calls=[];let failure=null,invalid=false,corrupt=false;const snapshots=new Set();let sequence=0;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=','base64');
 const operations={async execute(request,actor){calls.push({request,actor});if(failure)throw new Fault(failure,'Controlled browser presentation failure',409);if(invalid)return {unexpected:true};
  const identity={canvas,project,revision:'layout-2'};
  if(request.command.kind==='canvas.finish'){const removed=snapshots.size;for(const path of snapshots)await rm(path,{force:true});snapshots.clear();return {removed};}
  if(request.command.kind==='canvas.move')return {...identity,requestId:request.requestId,moved:request.command.input.positions.map(p=>p.id)};
  if(request.command.kind==='canvas.get')return {...identity,graphRevision:1,nodes:[{id:node,title:'Research',x:25,y:50,width:200,height:100,archived:false}],edges:[]};
  const output=join(root,`snapshot-${sequence++}.png`);await writeFile(output,corrupt?Buffer.alloc(png.length):png,{mode:0o600});snapshots.add(output);
  return {...identity,graphRevision:1,mediaType:'image/png',width:1,height:1,bounds:{x:25,y:50,width:200,height:100},bytes:png.length,sha256:createHash('sha256').update(png).digest('hex'),output,expiresAt:Date.now()+60000};
 }};
 const app=await serveApplication(config,access,operations);t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 async function cli(args){const env={...process.env};for(const key of ['HARNESSCTL_TOKEN','HARNESSCTL_CONFIG','DSH_HARNESSCTL_TOKEN','DSH_SHELL'])delete env[key];const child=spawn(process.execPath,[fileURLToPath(new URL('../bin/harnessctl',import.meta.url)),'--config',configPath,...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert(stdout.trim(),stderr);return {code,value:JSON.parse(stdout)};}
 return {root,calls,png,cli,setCorrupt(){corrupt=true;},setFailure(code){failure=code;},setInvalid(){invalid=true;}};
}

test('CLI writes snapshot PNG exclusively and keeps image bytes out of stdout on success and failure',async t=>{
 const f=await fixture(t),path=join(f.root,'graph.png');
 const captured=await f.cli(['canvas','snapshot',...base,'--output',path]);assert.equal(captured.code,0);assert.equal(captured.value.data.output,path);assert.equal(captured.value.data.expiresAt,null);assert.equal(captured.value.data.data,undefined);assert.equal(captured.value.data.revision,'layout-2');assert.deepEqual(await readFile(path),f.png);assert.equal((await stat(path)).mode&0o777,0o600);
 const duplicate=await f.cli(['canvas','snapshot',...base,'--output',path]);assert.equal(duplicate.code,6);assert.equal(duplicate.value.error.code,'OUTPUT_FAILED');assert.equal(duplicate.value.data.data,undefined);assert.doesNotMatch(duplicate.value.error.action,/retained/);assert.deepEqual(await readFile(path),f.png);
 const moved=await f.cli(['canvas','move',node,...move,'--x','1','--y','2']);assert.equal(moved.code,0);assert.equal(moved.value.data.requestId,requestId);assert.deepEqual(moved.value.data.moved,[node]);assert.equal(moved.value.data.reference,undefined);
 const state=await f.cli(['canvas','get',...base]);assert.equal(state.code,0);assert.equal(state.value.data.nodes[0].width,200);
});

test('CLI reports human edit conflicts, unavailable canvas and uncertain edits without research receipts',async t=>{
 const f=await fixture(t);
 for(const [code,exit] of [['CANVAS_BUSY',3],['CANVAS_CONFLICT',3],['REQUEST_ID_CONFLICT',3],['CANVAS_AMBIGUOUS',3],['CANVAS_UNAVAILABLE',5],['CANVAS_UNCERTAIN',7]]){f.setFailure(code);const result=await f.cli(['canvas','move',node,...move,'--x','1','--y','2']);assert.equal(result.code,exit);assert.equal(result.value.error.code,code);assert.equal(result.value.error.operation,undefined);assert.match(result.value.error.action,/canvas get/);}
 f.setFailure('CANVAS_STORAGE');const cleanupFailure=await f.cli(['canvas','finish','--project',project]);assert.match(cleanupFailure.value.error.action,/repeat canvas finish/);assert.doesNotMatch(cleanupFailure.value.error.action,/canvas get|owner receipt/);
 f.setFailure(null);f.setInvalid();const uncertain=await f.cli(['canvas','move',node,...move,'--x','1','--y','2']);assert.equal(uncertain.code,7);assert.equal(uncertain.value.error.code,'CANVAS_UNCERTAIN');assert.match(uncertain.value.error.action,/canvas get/);assert.equal(uncertain.value.error.operation,undefined);
});


test('temporary captures survive moves for comparison and finish is browser-independent and repeatable',async t=>{
 const f=await fixture(t);
 const before=await f.cli(['canvas','snapshot',...base]);assert.equal(before.code,0);assert.equal(typeof before.value.data.expiresAt,'number');assert.equal(before.value.data.data,undefined);assert.deepEqual(await readFile(before.value.data.output),f.png);
 await f.cli(['canvas','move',node,...move,'--x','1','--y','2']);
 const after=await f.cli(['canvas','snapshot',...base]);assert.equal(after.code,0);assert.notEqual(before.value.data.output,after.value.data.output);assert.deepEqual(await readFile(before.value.data.output),f.png);
 const exported=join(f.root,'lasting.png');assert.equal((await f.cli(['canvas','snapshot',...base,'--output',exported])).code,0);
 const finished=await f.cli(['canvas','finish','--project',project]);assert.equal(finished.code,0);assert.deepEqual(finished.value.data,{removed:3});assert.deepEqual(await readFile(exported),f.png);
 for(const path of [before.value.data.output,after.value.data.output])await assert.rejects(readFile(path),{code:'ENOENT'});
 const again=await f.cli(['canvas','finish','--project',project]);assert.equal(again.code,0);assert.deepEqual(again.value.data,{removed:0});
 const cleanup=f.calls.filter(call=>call.request.command.kind==='canvas.finish');assert(cleanup.every(call=>call.request.requestId===undefined));
});

test('export rejects changed temporary image bytes before creating a destination',async t=>{
 const f=await fixture(t),path=join(f.root,'export.png');f.setCorrupt();
 const result=await f.cli(['canvas','snapshot',...base,'--output',path]);assert.equal(result.code,6);assert.equal(result.value.error.code,'OUTPUT_FAILED');assert.equal(typeof result.value.data.expiresAt,'number');assert.notEqual(result.value.data.output,path);assert.equal(result.value.data.data,undefined);await assert.rejects(readFile(path),{code:'ENOENT'});
});
