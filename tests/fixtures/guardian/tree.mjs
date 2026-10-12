import {Socket} from 'node:net';
import {createInterface} from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [file, depth, stubborn, execution] = process.argv.slice(2);
// This fixture creates only descendants in the foreground group; it owns no
// detached native ranges. Report that empty execution boundary over its private FD.
if(execution&&execution!=='group'){
 const control=new Socket({fd:4});control.on('error',()=>{});
 createInterface({input:control}).on('line',line=>{const request=JSON.parse(line);if(request.method==='drain'&&execution!=='silent')control.write((execution==='malformed'?'invalid':JSON.stringify({id:request.id,settled:execution==='native'}))+'\n');});
}
if (stubborn === 'yes') process.on('SIGTERM', () => {});
appendFileSync(file, JSON.stringify({pid:process.pid,depth:Number(depth)})+'\n');
if(Number(depth)>0)spawn(process.execPath,[fileURLToPath(import.meta.url),file,String(Number(depth)-1),stubborn],{stdio:'inherit'});
process.stderr.write('CREDENTIAL-SENTINEL-MUST-BE-DROPPED\n');
process.stdin.resume();
setInterval(()=>{},1000);
