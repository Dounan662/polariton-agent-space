import { readFile } from 'node:fs/promises';
import { serveCapability } from './server-support.mjs';
import { createFixture } from './fixture.mjs';
const config=JSON.parse(await readFile(process.env.POLARITON_CONFIG_FILE,'utf8'));
const {version}=JSON.parse(await readFile(new URL('./version.json',import.meta.url),'utf8'));
await serveCapability({createServer:()=>createFixture(config,version,{
  record:value=>process.stdout.write(JSON.stringify({at:new Date().toISOString(),...value})+'\n'),
})});
