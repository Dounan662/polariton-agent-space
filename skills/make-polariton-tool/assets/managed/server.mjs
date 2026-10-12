import { readFile } from 'node:fs/promises';
import { serveCapability } from './server-support.mjs';
import { createCapability } from './capability.mjs';

const configuration=JSON.parse(await readFile(process.env.POLARITON_CONFIG_FILE,'utf8'));
await serveCapability({createServer:()=>createCapability(configuration)});
