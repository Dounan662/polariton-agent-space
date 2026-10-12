import {readFile,writeFile,mkdir,readdir,stat,cp} from 'node:fs/promises';
import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {homedir} from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'docs/evidence/adr009');
let secrets=[];try{secrets=(await readFile(join(root,'.env'),'utf8')).split('\n').filter(v=>/^[A-Z_]*(KEY|TOKEN|SECRET)=/.test(v)).map(v=>v.slice(v.indexOf('=')+1).trim()).filter(Boolean);}catch(error){if(error.code!=='ENOENT')throw error;}
const scrub=value=>{let text=value.replaceAll(root,'<V5>/').replaceAll(homedir(),'<HOME>').replace(/Bearer\s+[A-Za-z0-9_.-]+/g,'Bearer <REDACTED>').replace(/#token=[A-Za-z0-9_-]+/g,'#token=<REDACTED>');for(const secret of secrets)text=text.replaceAll(secret,'<REDACTED>');return text;};
async function copy(source,target){await mkdir(join(out,target,'..'),{recursive:true});await writeFile(join(out,target),scrub(await readFile(join(root,source),'utf8')));}
for(const attempt of [1,2]){
 const path=`.local/adr009/attempt-${attempt}`;
 for(const name of await readdir(join(root,`.local/adr009/rack/environments/live-environment-${attempt}/revisions`)))await copy(`.local/adr009/rack/environments/live-environment-${attempt}/revisions/${name}`,`attempt-${attempt}/revisions/${name}`);
 for(const name of (await readdir(join(root,path))).filter(name=>/^(builder-.*history|consumer-.*history|oracle-.*|inventory|report|version-r2)\.json$|^source-diff\.patch$|^daemon\.log$/.test(name)))await copy(`${path}/${name}`,`attempt-${attempt}/${name}`);
}
const runs=await Promise.all((await readdir(join(root,'.local/adr009-rack'))).filter(v=>v.startsWith('run-')).map(async name=>({name,time:(await stat(join(root,'.local/adr009-rack',name))).mtimeMs})));
runs.sort((a,b)=>b.time-a.time);const rack=runs[0].name;
for(const name of (await readdir(join(root,'.local/adr009-rack',rack))).filter(v=>/^(checks|containment-.*|bounded-recovery|daemon-crash-recovery|daemon-orphan-adoption)\.json$/.test(v)))await copy(`.local/adr009-rack/${rack}/${name}`,`infrastructure/${name}`);
const launch=await Promise.all((await readdir(join(root,'.local/adr009-launcher'))).filter(v=>v.startsWith('run-')).map(async name=>({name,time:(await stat(join(root,'.local/adr009-launcher',name))).mtimeMs})));
launch.sort((a,b)=>b.time-a.time);await copy(`.local/adr009-launcher/${launch[0].name}/evidence.json`,'infrastructure/launcher.json');
for(const name of ['build.log','tests.log'])await copy(`.local/adr009/${name}`,name);
await writeFile(join(out,'export.json'),JSON.stringify({rackRun:rack,launcherRun:launch[0].name,credentialsExported:false,providerRequests:0},null,2)+'\n');
console.log('Scrubbed ADR-009 evidence exported.');
