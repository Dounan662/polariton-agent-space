import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createCapability } from './capability.mjs';

test('MCP discovery, complete results and domain failure are public contracts',async t=>{
  const server=createCapability({scale:2});
  const client=new Client({name:'capability-verifier',version:'1.0.0'});
  t.after(async()=>{await client.close();await server.close();});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='scale_values'));
  const result=await client.callTool({name:'scale_values',arguments:{values:[-2,0,3]}});
  assert.deepEqual(result.structuredContent,{scale:2,values:[-4,0,6]});
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  assert.equal((await client.callTool({name:'scale_values',arguments:{values:[Number.MAX_VALUE]}})).isError,true);
  assert.equal((await client.callTool({name:'scale_values',arguments:{values:[]}})).isError,true);
  const version=await client.readResource({uri:'capability://version'});
  assert.equal(JSON.parse(version.contents[0].text).version,'1.0.0');
});
