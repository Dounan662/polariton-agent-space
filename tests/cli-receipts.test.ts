import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Operation} from '../src/operations.ts';
import {compactReceipt} from '../src/cli/receipts.ts';
import {identity} from '../src/cli/identity.ts';

const request='11111111-1111-4111-a111-111111111111',node='22222222-2222-4222-a222-222222222222';
function receipt(command:string,input:unknown,result:unknown,state='succeeded',error:unknown=null){return Operation.parse({reference:`main:research:${request}`,requestId:request,actor:{kind:'owner',id:'local-owner'},command,input,result,state,error,attempts:[{at:1,state}]});}

test('compact research receipts identify only the affected graph entity and preserve publication evidence references',()=>{
 const nodes=[{id:node,title:'Existing',archived:false},{id:identity(request,'node'),title:'New',description:'Long scientific background',archived:false}];
 const edge={id:identity(request,'relation'),from:node,to:nodes[1]!.id,relation:'supports',explanation:'Detailed reasoning',retracted:false};
 const graph={revision:3,nodes,edges:[edge],recovery:null};
 for(const [command,input,id] of [
  ['node.create',{project:node},nodes[1]!.id],['node.update',{target:node,project:node},node],
  ['relation.create',{project:node},edge.id],['relation.update',{target:edge.id,project:node},edge.id],['relation.retract',{target:edge.id,project:node},edge.id],
 ] as const){const view=compactReceipt(receipt(command,input,graph));assert(view.result&&'id' in view.result);assert.equal(view.result.id,id);assert.match(view.inspect.resource!,/graph get/);assert.equal('nodes' in view.result!,false);assert.equal('explanation' in view.result!,false);}
 const repair=compactReceipt(receipt('graph.repair-tail',{project:node},graph));assert(repair.result&&'revision' in repair.result);assert.equal(repair.result.revision,3);
 const checkpoint=compactReceipt(receipt('checkpoint.publish',{node,note:'Unfinished research'}, {id:request,nodeId:node,commit:'a'.repeat(40),publisher:{kind:'owner',id:'local-owner'},note:'Unfinished research',createdAt:1}));
 assert(checkpoint.result&&'commit' in checkpoint.result);assert.equal('fileCount' in checkpoint.result,false);assert.equal(checkpoint.result.commit,'a'.repeat(40));assert.match(checkpoint.inspect.resource!,/checkpoint get.*--node/);assert.equal('files' in checkpoint.result!,false);
});

test('compact infrastructure receipts retain identity, readiness and specific failures without definitions or credentials',()=>{
 const cases:[string,unknown,unknown,string,unknown][]=[
  ['capability.register',{repository:'/source'},{id:'cap',name:'Capability',kind:'managed',source:{repository:'/source'}},'id','cap'],
  ['capability.revise',{id:'cap'},{id:'cap',revisionId:'rev',url:'http://private.invalid',headers:{Authorization:'secret'}},'revisionId','rev'],
  ['catalog.provision',{entryId:'entry'},{capabilityId:'cap',releaseId:null,state:'registered',entry:{description:'large manifest'}},'state','registered'],
  ['release.install',{packageId:'cap'},{id:'rel',packageId:'cap',commit:'a'.repeat(40),provenance:{build:['secret']}},'id','rel'],
  ['environment.publish',{document:{}},{environmentId:'env',revisionId:'rev',components:[{id:'one',releaseId:'rel',configuration:{secret:'secret'}}]},'revisionId','rev'],
  ['environment.apply',{environmentId:'env'},{id:'prep',environmentId:'env',revisionId:'rev',status:'partial',components:[{componentId:'one',mountId:null,readiness:'unavailable',error:'Runtime unavailable',errorCode:'RUNTIME_UNAVAILABLE'}]},'status','partial'],
  ['environment.remove',{environmentId:'env'},{environmentId:'env',revisionId:'rev',removedAt:1},'environmentId','env'],
  ['mount.create',{id:'mount'},{id:'mount',state:'running',endpoint:'http://private.invalid',component:{configuration:{secret:'secret'}}},'state','running'],
  ['mount.stop',{id:'mount'},{id:'mount',state:'draining',error:null},'state','draining'],
  ['mount.replace',{id:'mount'},{id:'mount',state:'failed',error:'Runtime unavailable'},'error','Runtime unavailable'],
  ['binding.create',{mountId:'mount'},{bindingId:'binding'},'bindingId','binding'],
  ['binding.release',{id:'binding'},{released:true},'released',true],
 ];
 for(const [command,input,result,key,expected] of cases){const view=compactReceipt(receipt(command,input,result));assert.equal((view.result as Record<string,unknown>)[key],expected,command);assert.ok(view.inspect.resource,command);assert(!JSON.stringify(view).includes('secret'),command);}
 const imported=compactReceipt(receipt('capability.import',{entries:[]},{capabilities:[{id:'cap',name:'Capability',revisionId:'rev',url:'http://private.invalid',headers:{Authorization:'secret'}}]}));
 assert.deepEqual(imported.result,{capabilities:[{id:'cap',name:'Capability',revisionId:'rev'}]});
 const applied=compactReceipt(receipt('environment.apply',{environmentId:'env'},cases[5]![2],'partial'));
 assert.deepEqual((applied.result as {components:unknown[]}).components,[{componentId:'one',mountId:null,readiness:'unavailable',error:'Runtime unavailable',errorCode:'RUNTIME_UNAVAILABLE'}]);
 const failed=compactReceipt(receipt('release.install',{target:'cap'},null,'failed',{code:'BUILD_FAILED',message:'Build failed'}));assert.deepEqual(failed.error,{code:'BUILD_FAILED',message:'Build failed'});assert.equal(failed.result,null);
});

test('compact lifecycle receipts retain peer errors and settled state without startup configuration',()=>{
 const failed=compactReceipt(receipt('daemon.start',{target:'environment'},{environment:{state:'failed',error:'Startup failed',configuration:{token:'secret'}}},'failed'));
 assert.deepEqual(failed.result,{environment:{state:'failed',error:'Startup failed'}});
 const stopped=compactReceipt(receipt('daemon.stop',{target:'all'},{startup:{main:{state:'running',status:{pid:17}},environment:{state:'running'}},settlement:{main:{state:'stopped'},environment:{state:'stopped'}}}));
 assert.deepEqual(stopped.result,{startup:{main:{state:'running',status:{pid:17}},environment:{state:'running'}},settlement:{main:{state:'stopped'},environment:{state:'stopped'}}});
});

test('compact preparation keeps actionable recovery and distinct evidence while detailed definitions remain opt-in',()=>{
 const evidence={registered:true,dependencies:'unavailable',connection:'untested',tools:[],authentication:'not-required',checks:[{name:'browse',status:'not-run'}],observedAt:null};
 const action={id:'node',componentId:'browser',kind:'toolchain',tool:'node',code:'PACKAGE_TOOL_MISSING',message:'Node is unavailable',actor:'initiator',next:'harnessctl operation continue environment:example --input resolution.json'};
 const result={status:'blocked',version:2,environmentId:'browser',revisionId:'rev',components:[{id:'browser',name:'Browser',source:{kind:'npm',identifier:'@playwright/mcp',version:'0.0.83'},runtime:{kind:'local'},connection:{kind:'stdio',args:[],env:{}},requirements:{files:[],identityFiles:[],assets:[],nativeBuild:false},authentication:{kind:'none'},checks:[],capabilityId:'cap',capabilityRevisionId:'cap-rev',evidence,error:{code:'PACKAGE_TOOL_MISSING',message:'Node is unavailable'}}],actions:[action],defaults:['Separate access storage'],connection:'untested',operationId:request};
 const view=compactReceipt(receipt('environment.prepare',{name:'Browser',source:'npm:@playwright/mcp@0.0.83'},result,'partial'));
 assert(view.result&&'actions' in view.result);assert.deepEqual(view.result.actions,[action]);assert.equal(view.result.version,2);assert.deepEqual(view.result.components[0]?.evidence,evidence);
 assert(!('source' in view.result.components[0]!));assert.match(view.inspect.resource!,/environment inspect.*--revision/);
 const validation={environmentId:'browser',revisionId:'rev',observedAt:'2026-10-13T12:00:00Z',scope:'discovery',components:[{componentId:'browser',connected:true,tools:['browser_navigate'],check:null,error:null,cleanup:'settled'}]};
 assert.deepEqual(compactReceipt(receipt('environment.validate',{target:'browser',revision:'rev'},validation)).result,validation);
 const cancelled=compactReceipt(receipt('operation.cancel',{target:`environment:${request}`},{cancelled:true,operation:`environment:${request}`}));
 assert.deepEqual(cancelled.result,{cancelled:true,operation:`environment:${request}`});assert.match(cancelled.inspect.resource!,/operation get 'environment:/);
});

test('standalone capability receipts retain source-independent setup identity without an environment link',()=>{
 const result={status:'draft',version:0,environmentId:null,revisionId:null,components:[{id:'tool',name:'Mail',source:{kind:'endpoint',url:'https://example.com/mcp'},runtime:{kind:'external'},connection:{kind:'http',headers:{}},requirements:{files:[],identityFiles:[],assets:[],nativeBuild:false},authentication:{kind:'none'},checks:[],capabilityId:null,capabilityRevisionId:null,evidence:{registered:false,dependencies:'unprepared',connection:'untested',tools:[],authentication:'not-required',checks:[],observedAt:null},error:null}],actions:[],defaults:[],connection:'untested',operationId:`environment:${request}`};
 const view=compactReceipt(receipt('capability.add',{name:'Mail',source:'https://example.com/mcp'},result,'waiting'));
 assert(view.result&&'environmentId' in view.result&&'status' in view.result);assert.equal(view.result.environmentId,null);assert.equal(view.result.status,'draft');assert.equal(view.inspect.resource,undefined);assert.match(view.inspect.operation,/operation get/);
});
