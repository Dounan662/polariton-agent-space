import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {createFixture} from './fixture.mjs';

test('prepared capability reports independently recorded versioned MCP outcomes',async t=>{
  const connect=async(role,version)=>{
    const records=[],server=createFixture({role,seed:'independent-known-seed',slowMs:20},version,{record:value=>records.push(value),receipt:()=>`${role}-${version}-${records.length}`});
    const client=new Client({name:'fixture-verifier',version:'1'});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);await client.connect(clientTransport);
    t.after(async()=>{await client.close();await server.close();});return {client,records};
  };
  const measured=await connect('measurement',1);
  assert.deepEqual((await measured.client.listTools()).tools.map(tool=>tool.name),['measure']);
  const result=await measured.client.callTool({name:'measure',arguments:{sample:'alpha'}});
  assert.deepEqual(result.structuredContent,{sample:'alpha',value:7569,receipt:'measurement-1-0',role:'measurement',version:1});
  assert.equal(measured.records[0].phase,'started');assert.deepEqual(measured.records[1].result,result);
  for(const [version,expected] of [[1,22718],[2,53002]]){
    const transformed=await connect('transform',version);
    assert.deepEqual((await transformed.client.listTools()).tools.map(tool=>tool.name),['transform']);
    const result=await transformed.client.callTool({name:'transform',arguments:{sample:'alpha',value:7569,measurementReceipt:'measurement-1-0'}});
    assert.equal(result.structuredContent.value,expected);assert.equal(result.structuredContent.measurementReceipt,'measurement-1-0');
    assert.equal((await transformed.client.callTool({name:'transform',arguments:{sample:'bad',value:7569,measurementReceipt:'measurement-1-0',mode:'error'}})).isError,true);
  }
  const controller=new AbortController();
  const pending=measured.client.callTool({name:'measure',arguments:{sample:'cancel',mode:'slow'}},{signal:controller.signal});
  // Notification delivery is asynchronous; wait for the fixture's public invocation record.
  while(!measured.records.some(value=>value.input.sample==='cancel'))await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await assert.rejects(pending);
  // A caller abort is not proof that a remote tool stopped. Retain its actual
  // terminal record; both completion and transport-propagated cancellation are truthful.
  while(!measured.records.some(value=>value.input.sample==='cancel'&&value.phase!=='started'))await new Promise(resolve=>setImmediate(resolve));
  assert.equal(measured.records.filter(value=>value.input.sample==='cancel'&&value.phase==='started').length,1);
  assert.equal((await measured.client.callTool({name:'measure',arguments:{sample:'alpha'}})).structuredContent.value,7569);
});
