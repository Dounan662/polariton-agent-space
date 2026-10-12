import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createRelease} from '../src/deployment.ts';

const [version,destination,...extra]=process.argv.slice(2);
if(!version||!destination||extra.length)throw new Error('Usage: node scripts/package-release.mjs VERSION OUTPUT_DIRECTORY');
console.log(JSON.stringify(await createRelease(fileURLToPath(new URL('../',import.meta.url)),resolve(destination),version),null,2));
