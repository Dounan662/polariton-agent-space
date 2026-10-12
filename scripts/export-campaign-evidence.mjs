/** Execution-free audit of a synthetic campaign; never loads credentials. */
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {readHistory} from '../harness/history.mjs';
import {loadConfig,CampaignConfig,sourceRoot} from '../src/config.ts';
const id=process.argv[2]??'adr006';if(!['adr006','adr007'].includes(id))throw new Error('Unknown campaign');
const config=await loadConfig(join(sourceRoot,`config/${id}-app.json`));
const campaign=CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8')));
const destination=join(sourceRoot,`docs/evidence/${id}`);await mkdir(destination,{recursive:true});
const agents=new DatabaseSync(join(config.stateRoot,'agents.sqlite'),{readOnly:true});
const tree=new DatabaseSync(join(config.stateRoot,'research.sqlite'),{readOnly:true});
const budget=new DatabaseSync(resolve(dirname(config.campaign),campaign.ledger),{readOnly:true});
const projects=tree.prepare('SELECT id,name,root FROM projects').all();
const workers=agents.prepare('SELECT data FROM workers').all().map(row=>JSON.parse(row.data));
const scrub=value=>{let text=JSON.stringify(value,null,2);for(const project of projects)text=text.replaceAll(project.root,`<PROJECT:${project.id}>`);text=text.replaceAll(sourceRoot,'<V5>').replaceAll(homedir(),'<HOME>');if(/sk-[A-Za-z0-9]{20,}/.test(text))throw new Error('Possible credential in evidence; export stopped');return text+'\n';};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={status:'evidence-only; acceptance results are in VERIFICATION.md',recordedAt:new Date().toISOString(),campaign,ledger:budget.prepare('SELECT requests,elapsed FROM budget').get(),workers:[],projects:[],observations:{},cold:JSON.parse(await readFile(join(sourceRoot,`.local/${id}/cold-proof.json`),'utf8'))};
for(const worker of workers){if(!worker.harnessSessionId)continue;
 const history=await readHistory(join(config.stateRoot,'harness',worker.id,'sessions'),worker.harnessSessionId,{limit:config.maxHistoryEvents});
 const events=history.events;
 await writeFile(join(destination,`source-${worker.id}.json`),scrub({formatVersion:history.header.version,sourceSessionId:worker.harnessSessionId,originalEventsSha256:hash(JSON.stringify(events)),redactions:['host source and synthetic workspace paths'],events}));
 const intervals=events.filter(e=>e.type==='turn/start').map(start=>({turn:start.data.turn,start:start.time,end:events.find(e=>e.type==='turn/end'&&e.data.turn===start.data.turn)?.time??null}));
 report.workers.push({id:worker.id,node:worker.nodeId,harnessSessionId:worker.harnessSessionId,title:worker.title,state:worker.state,model:worker.model,eventCount:events.length,intervals,requests:events.filter(e=>e.type==='request/header').map(e=>({seq:e.seq,header:e.data.header})),usage:events.filter(e=>e.type==='assistant/message').map(e=>({seq:e.seq,usage:e.data.usage})),tools:events.filter(e=>e.type==='tool/call').map(e=>({seq:e.seq,time:e.time,...e.data})),receipts:agents.prepare('SELECT data FROM submissions WHERE worker_id=?').all(worker.id).map(row=>JSON.parse(row.data)),images:agents.prepare('SELECT data FROM images WHERE worker_id=?').all(worker.id).map(row=>JSON.parse(row.data))});
}
async function files(root,path=''){let result=[];for(const entry of await readdir(join(root,path),{withFileTypes:true})){if(entry.name==='.git'||entry.name==='.polariton')continue;const relative=join(path,entry.name);if(entry.isDirectory())result.push(...await files(root,relative));else if(entry.isFile()){const bytes=await readFile(join(root,relative));result.push({path:relative,bytes:bytes.length,sha256:hash(bytes)});}}return result;}
for(const project of projects){const graph=await readFile(join(project.root,'.polariton/graph.jsonl'),'utf8');await writeFile(join(destination,`graph-${project.id}.jsonl`),graph);report.projects.push({...project,files:await files(project.root)});}
const observations=(await readFile(join(sourceRoot,`.local/${id}/live-observation.jsonl`),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
report.observations={count:observations.length,streamFrames:observations.filter(v=>v.kind==='assistant-stream').length,disconnects:observations.filter(v=>v.kind==='transport-interruption'),firstAt:observations[0]?.observedAt,lastAt:observations.at(-1)?.observedAt};
await writeFile(join(destination,'live-observations.json'),scrub(observations));
const originalPath=join(sourceRoot,'.local/verification-budget.sqlite');
let preserved={status:'unavailable',detail:'Historical first-build ledger is absent; no file was created or reset'};
try {
 await stat(originalPath);
 const original=new DatabaseSync(originalPath,{readOnly:true});
 try {preserved={status:'present',...original.prepare('SELECT requests,elapsed FROM budget').get()};}
 finally {original.close();}
 if(preserved.requests!==26||preserved.elapsed!==428959)throw new Error('Original ledger changed');
} catch(error) {if(error.code!=='ENOENT')throw error;}
report.historicalLedger=preserved;
await writeFile(join(destination,'live-audit.json'),scrub(report));
console.log(JSON.stringify({ledger:report.ledger,original:preserved,sourceCuts:report.workers.map(s=>({worker:s.id,events:s.eventCount})),observations:report.observations}));
for(const database of [agents,tree,budget])database.close();
