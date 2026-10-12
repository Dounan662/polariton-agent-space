import { mkdir, cp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, sourceRoot } from '../src/config.ts';

// Compare the shipped DSH browser against copies of synthetic evidence. Model access is denied.
const config = await loadConfig(resolve(process.argv[2] ?? 'config/browser-verification.json'));
const db = new DatabaseSync(join(config.stateRoot,'agents.sqlite'),{readOnly:true});
const workers = db.prepare('SELECT data FROM workers').all().map(row=>JSON.parse(row.data)); db.close();
const home = join(sourceRoot,'.local/reference-browser'); await mkdir(home,{recursive:true});
for(const worker of workers) if(worker.harnessSessionId) await cp(join(config.stateRoot,'harness',worker.id,'sessions'),join(home,'sessions'),{recursive:true});
await writeFile(join(home,'deny.mjs'),`export const inject=['llm']; export function apply(ctx){ctx.on('llm/stream',async function*(){yield {type:'finish',reason:{kind:'error',failure:{code:'REFERENCE_READ_ONLY',message:'Model access disabled for browser comparison'}}};});}`);
const patch = ['session-log-deepseek','plugin-package-inventory-deepseek','session-telemetry-otel','session-title-llm','agent-instructions','skill-filesystem'].map(id=>({id,disabled:true}));
patch.push({insert:[{id:'reference-deny-model',name:join(home,'deny.mjs')}]});
await writeFile(join(home,'cordis.patch.yml'),JSON.stringify(patch));
const child=spawn(process.execPath,[join(sourceRoot,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','web','--no-open','--port','4306'],{cwd:home,env:{PATH:process.env.PATH,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
