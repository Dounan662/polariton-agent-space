import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/main.ts';
import {loadConfig} from '../../src/config.ts';
import {RackConfig} from '../../src/environment/contracts.ts';

// Disposable real Main: no workers are activated and no user storage is opened.
const port=Number(process.argv[2]),metadata=process.argv[3];
if(!Number.isInteger(port)||port<1||port>65535||!metadata)throw new Error('Usage: node tests/browser/workspace-folder-host.ts PORT METADATA_FILE');
const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-folder-')));
const environmentConfig=join(root,'environment.json');
await writeFile(environmentConfig,JSON.stringify(RackConfig.parse({stateRoot:join(root,'rack'),socketPath:join(root,'rack.sock')})));
const config={...await loadConfig(),port,stateRoot:join(root,'main'),runtimeDirectory:join(root,'runtime'),sharedSkillsDir:join(root,'skills'),environmentConfig,verification:false};
const runtime=await createApp(config);
await runtime.app.listen({host:'127.0.0.1',port:config.port});
await writeFile(metadata,JSON.stringify({url:runtime.launchUrl,projectRoot:join(root,'Workspace with spaces')}),{mode:0o600});
console.log('Disposable workspace-folder test host ready');
async function stop(){await runtime.app.close();await rm(root,{recursive:true,force:true});process.exit();}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
