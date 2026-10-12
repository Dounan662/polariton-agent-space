import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

/** Trigger the pinned SDK's real absent-capability diagnostics before ACP starts.
 * The same Node process subsequently boots unmodified DSH. No model is used. */
const client=new Client({name:'adr011-diagnostic-probe',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))]}));
try{
  const resources=await client.listResources(),templates=await client.listResourceTemplates();
  await writeFile(process.env.ADR011_DIAGNOSTIC_RECEIPT,JSON.stringify({resources,templates}),{mode:0o600});
}finally{await client.close();}
