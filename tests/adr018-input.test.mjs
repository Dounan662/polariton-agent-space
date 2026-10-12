import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Harness} from '../harness/client.ts';
import {loadConfig} from '../src/config.ts';

test('production composition admits mixed image content through the semantic port without provider admission',{timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-input-contract-')),workspace=join(root,'workspace');await mkdir(workspace);
 const config={...await loadConfig(),verification:true};let attempts=0;
 const harness=new Harness(config,join(root,'dsh'),workspace,async()=>{attempts++;return false;});
 t.after(async()=>{await harness.close();await rm(root,{recursive:true,force:true});});
 const capability=await harness.start();assert.equal(capability.image,true);
 const opened=await harness.activate(null,[]),id=randomUUID();
 const ended=Promise.withResolvers();let turnId;
 const observeTurn=value=>{
  if(value.sessionId!==opened.sessionId)return;
  if(value.phase==='claimed'&&value.requestId===id)turnId=value.id;
  if(value.phase==='ended'&&value.id===turnId)ended.resolve(value);
 };
 harness.on('turn',observeTurn);
 const timer=setTimeout(()=>ended.reject(new Error('Image turn did not settle')),config.requestTimeoutMs);
 t.after(()=>{clearTimeout(timer);harness.off('turn',observeTurn);});
 const image=await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).png().toBuffer();
 try{const response=await harness.message(opened.sessionId,id,[{type:'text',text:'Inspect image'},{type:'image',data:image.toString('base64'),mimeType:'image/png'}],{kind:'human'});assert(response.messageId);}
 catch(error){assert.fail(`Mixed content rejected: ${error.code??'unknown'}: ${error.message}`);}
 const turn=await ended.promise;clearTimeout(timer);
 assert.equal(turn.reason.kind,'error');assert.equal(turn.reason.error.code,'POLARITON_REQUEST_BUDGET_EXHAUSTED');
 assert.equal(attempts,1);
 const events=(await harness.observe(opened.sessionId)).events,source=events.find(event=>event.type==='user/message'&&event.data.source.rpcId===id);
 assert(source);assert.deepEqual(source.data.content.map(part=>part.type),['text','image']);
 assert(source.data.content[1].attachment,'Native trajectory stores its durable attachment reference');
});
