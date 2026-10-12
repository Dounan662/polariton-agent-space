import {fileURLToPath} from 'node:url';
import {installRelease} from '../src/deployment.ts';

if(process.argv.length!==2)throw new Error('Usage: node scripts/install.mjs (XDG directory overrides are supported)');
const result=await installRelease(fileURLToPath(new URL('../',import.meta.url)));
console.log(JSON.stringify(result,null,2));
console.log('Installation prepared; no services were started. Run systemctl --user start polariton.target, open the browser link from the Main log, then connect a model provider in Settings.');
