// Historical first-build evidence reproducer: reads the original pre-007 snapshot only.
// Current worker campaigns use export-campaign-evidence.mjs.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readHistory } from '../harness/history.mjs';
import { loadConfig, sourceRoot } from '../src/config.ts';

// Audit saved synthetic acceptance outputs; never activate DSH or open the credential file.
const config=await loadConfig(resolve(process.argv[2]??'config/browser-verification.json'));
const destination=join(sourceRoot,'docs/evidence');await mkdir(destination,{recursive:true});
const scrub=value=>JSON.stringify(value,null,2).replaceAll(sourceRoot,'<V5>');
const agents=new DatabaseSync(join(config.stateRoot,'agents.sqlite'),{readOnly:true});
const tree=new DatabaseSync(join(config.stateRoot,'research.sqlite'),{readOnly:true});
const budget=new DatabaseSync(join(sourceRoot,'.local/verification-budget.sqlite'),{readOnly:true});
const sessions=agents.prepare('SELECT data FROM sessions').all().map(r=>JSON.parse(r.data));
const records=[];
for(const session of sessions){
  const history=await readHistory(join(config.stateRoot,'harness',session.id,'sessions'),session.harnessId,{limit:config.maxHistoryEvents});
  const sourceHash=createHash('sha256').update(JSON.stringify(history.events)).digest('hex');
  await writeFile(join(destination,`session-${session.title.replaceAll(' ','-').toLowerCase()}.json`),scrub({formatVersion:history.header.version,sourceSessionId:session.harnessId,originalEventsSha256:sourceHash,redactions:['V5 absolute source root'],events:history.events}));
  records.push({session,events:history.events,sourceHash});
}
const first=records.find(r=>r.session.title==='Session 1'),second=records.find(r=>r.session.title==='Session 2');
const interval=(record,turn)=>({start:record.events.find(e=>e.type==='turn/start'&&e.data.turn===turn).time,end:record.events.find(e=>e.type==='turn/end'&&e.data.turn===turn).time});
const one=interval(first,1),two=interval(second,1),interrupt=interval(first,2);
assert.ok(Math.max(one.start,two.start)<Math.min(one.end,two.end));assert.ok(interrupt.end<two.end);
const receipts=agents.prepare('SELECT data FROM submissions').all().map(r=>JSON.parse(r.data));
const steer=receipts.find(r=>r.kind==='steer');const applied=first.events.find(e=>e.type==='user/message'&&e.data.source?.rpcId===steer.id);
assert.ok(applied&&applied.time>=one.start&&applied.time<=one.end);
assert.ok(first.events.some(e=>e.type==='approval/decided'));
assert.ok(first.events.some(e=>e.type==='tool/call'&&e.data.name==='read'));
const project=tree.prepare('SELECT id FROM projects WHERE name=?').get('V5 acceptance laboratory').id;
const projectRoot=join(config.stateRoot,'projects',project);
const graphBytes=await readFile(join(projectRoot,'.polariton/graph.jsonl'),'utf8');
await writeFile(join(destination,'graph.jsonl'),graphBytes);
const creations=graphBytes.trim().split('\n').map(line=>JSON.parse(line).mutation.command).filter(c=>c.kind==='node.create');
const a=creations.find(c=>c.title.startsWith('A ')),b=creations.find(c=>c.title.startsWith('B ')),c=creations.find(c=>c.title.startsWith('C '));
const workspace=node=>join(projectRoot,'nodes',node.id);
const git=(node,args)=>execFileSync('git',['-C',workspace(node),...args],{encoding:'utf8'}).trim();
const checkpoint=tree.prepare('SELECT commit_id FROM checkpoints WHERE node=?').get(a.id).commit_id;
const sourceFiles=git(a,['ls-tree','-r','--name-only',checkpoint]).split('\n');
for(const file of sourceFiles){assert.deepEqual(await readFile(join(workspace(b),file)),execFileSync('git',['-C',workspace(a),'show',`${checkpoint}:${file}`]));}
assert.deepEqual((await readdir(workspace(c))).filter(f=>f!=='.git'),[]);
assert.equal(git(b,['rev-list','--count','HEAD']),'1');
assert.equal(await readFile(join(workspace(a),'guided.txt'),'utf8'),'guidance-applied\n');
assert.equal(await readFile(join(workspace(a),'interrupt.txt'),'utf8'),'interrupt-start\n');
assert.equal(await readFile(join(workspace(a),'resumed.txt'),'utf8'),'resumed\n');
assert.equal(await readFile(join(workspace(a),'two.txt'),'utf8'),'session-two-start\nsession-two-end\n');
assert.equal(sessions.filter(s=>s.nodeId===b.id||s.nodeId===c.id).length,0);
const cold=JSON.parse(await readFile(join(sourceRoot,'.local/cold-browser-proof.json'),'utf8'));assert.equal(cold.children.length,0);assert.ok(cold.sessions.every(s=>s.state==='inactive'));assert.equal(cold.requests,23);
const result={status:'pass',checkedAt:new Date().toISOString(),provider:config.provider,model:config.model,budget:budget.prepare('SELECT requests,elapsed FROM budget').get(),overlap:{one,two},interrupt,steering:{submissionId:steer.id,appliedSeq:applied.seq,withinTurn:1},cold,checkpoint,inheritance:{sourceNode:a.id,node:b.id,files:sourceFiles,independentInitialCommit:git(b,['rev-parse','HEAD']),sessionCount:0},emptyNode:{id:c.id,files:0,sessions:0},receipts,sourceCuts:records.map(r=>({sessionId:r.session.id,harnessId:r.session.harnessId,eventCount:r.events.length,sha256:r.sourceHash}))};
await writeFile(join(destination,'acceptance.json'),scrub(result));
for(const [source,name] of [['report.json','qualification.json'],['controls-report.json','qualification-controls.json'],['permission-report.json','qualification-permission.json']]){const original=JSON.parse(await readFile(join(sourceRoot,'.local/qualification/2026-09-15T21-13-50.430Z',source),'utf8'));if(source==='report.json'){delete original.requests;original.note='Removed unused report.requests=0 field; budget.requests is the actual durable shared count.';}await writeFile(join(destination,name),scrub(original));}
console.log(JSON.stringify({status:result.status,budget:result.budget,events:result.sourceCuts.map(c=>c.eventCount),files:sourceFiles}));
agents.close();tree.close();budget.close();
