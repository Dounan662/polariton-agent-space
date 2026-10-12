/** Authorized synthetic live campaign. SIGUSR2 simulates a lost browser transport without stopping work. */
import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig,sourceRoot} from '../src/config.ts';
import {createApp} from '../src/main.ts';
const campaign=process.argv[2]??'adr006';if(!['adr006','adr007'].includes(campaign))throw new Error('Unknown campaign');
const config=await loadConfig(join(sourceRoot,`config/${campaign}-app.json`));
if(process.argv.includes('--rerun'))config.verificationRerun=true;
if(!config.verification||!config.campaign)throw new Error('A dedicated campaign configuration is required');
const directory=join(sourceRoot,`.local/${campaign}`);await mkdir(directory,{recursive:true});
const runtime=await createApp(config);let writes=Promise.resolve();
const record=value=>{writes=writes.then(()=>appendFile(join(directory,'live-observation.jsonl'),JSON.stringify({observedAt:Date.now(),...value})+'\n'));writes.catch(error=>{console.error('Evidence write failed:',error.message);void runtime.app.close();});};
runtime.agents.on('observation',value=>record(value));
process.on('SIGUSR2',()=>{record({kind:'transport-interruption',clients:runtime.app.websocketServer.clients.size});for(const socket of runtime.app.websocketServer.clients)socket.terminate();});
const stop=()=>{void runtime.app.close().then(()=>writes).catch(error=>{console.error(error.message);process.exitCode=1;});};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
await runtime.app.listen({host:'127.0.0.1',port:config.port});
await writeFile(join(directory,'live-process.json'),JSON.stringify({pid:process.pid,startedAt:Date.now(),port:config.port}));
console.log(runtime.launchUrl);
