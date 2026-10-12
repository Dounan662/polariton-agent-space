import {writeFile} from 'node:fs/promises';
import {releaseInputs,verifyRelease} from '../harness/release.ts';
if(process.argv.includes('--write'))await writeFile(new URL('../harness/release.json',import.meta.url),JSON.stringify(await releaseInputs(),null,2)+'\n');
else await verifyRelease();
