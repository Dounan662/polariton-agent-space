import {nativeTurn} from './native-turn.mjs';
import {loadConfig,CampaignConfig,QualificationConfig} from '../src/config.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Harness } from '../harness/client.ts';
import { readHistory } from '../harness/history.mjs';
import { VerificationBudget } from '../harness/budget.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const campaignId=process.argv.includes('--campaign')?process.argv[process.argv.indexOf('--campaign')+1]:undefined;
if(campaignId&&!['adr006','adr007'].includes(campaignId))throw new Error('Unknown campaign');
const config=campaignId?await loadConfig(resolve(root,`config/${campaignId}-app.json`)):{...await loadConfig(),...QualificationConfig.parse(JSON.parse(await readFile(resolve(root,'config/qualification.json'),'utf8'))),verification:true};
const limits=campaignId?CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8'))):config;
const ledgerPath=campaignId?resolve(dirname(config.campaign),limits.ledger):resolve(root,'.local/verification-budget.sqlite');
const run = resolve(root, '.local/qualification', new Date().toISOString().replaceAll(':', '-'));
const workspace = resolve(run, 'workspace');
await mkdir(workspace, { recursive: true });
execFileSync('git', ['init', '--quiet', workspace]);
const report = { version: '0.2.0-rc.2', checks: [] };
const harnesses = [];
const live = process.argv.includes('--live');
if (live && !process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('Set DEEPSEEK_API_KEY in the ignored V5 .env file before live qualification');
const ledger = live ? new VerificationBudget(ledgerPath, process.argv.includes('--rerun')?{...limits,reserveRequests:0,reserveMs:0}:limits) : undefined;
const budget = async () => ledger?.reserve() ?? false;
const deadline = ledger ? setTimeout(() => {
  for (const h of harnesses) void h.close().catch(error=>console.error(error));
}, ledger.remainingMs) : undefined;
function waitEvent(h, name, predicate) {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { h.off(name, listener); reject(new Error(`Timed out waiting for ${name}`)); }, config.requestTimeoutMs);
    const listener = data => { if (predicate(data)) { clearTimeout(timer); h.off(name, listener); accept(data); } };
    h.on(name, listener);
  });
}
try {
  const h = new Harness(config, resolve(run, 'dsh'), workspace, budget);
  harnesses.push(h);
  await h.start();
  const one = await h.activate(null, []);
  const h2 = new Harness(config, resolve(run, 'dsh2'), workspace, budget);
  harnesses.push(h2); await h2.start();
  const two = await h2.activate(null, []);
  assert.notEqual(one.sessionId, two.sessionId);
  report.checks.push({ name: 'two-distinct-sessions-same-workspace', status: 'pass', sessions: [one.sessionId, two.sessionId] });
  if (live) {
    const independent = two;
    const events = [];
    const updates = [];
    for (const peer of [h, h2]) {
      peer.on('source', value => events.push({ ...value, receivedAt: Date.now() }));
      peer.on('status', value => updates.push(value));
      peer.on('permission', value => events.push({ type: 'permission', sessionId: value.sessionId }));
    }
    const prompt = (h, id, text) => nativeTurn(h, id, text, config.requestTimeoutMs);
    const firstTool = waitEvent(h, 'source', value => value.sessionId === one.sessionId && value.type === 'tool/call');
    const p1 = prompt(h, one.sessionId, 'Use your built-in bash tool to execute: sleep 8; printf "one\\n" > one.txt . Then report completion briefly. Work only in this directory. Do not delegate.');
    const p2 = prompt(h2, independent.sessionId, 'Use your built-in bash tool to execute: sleep 12; printf "two\\n" > two.txt . Then report completion briefly. Work only in this directory. Do not delegate.');
    // Observe failures immediately while waiting at the tool boundary.
    const turns = Promise.all([p1, p2]);
    turns.catch(() => {});
    await Promise.race([firstTool, turns.then(() => { throw new Error('Turns ended before a steering boundary'); })]);
    const steeringId = 'qualification-steer-1';
    const steering = await h.message(one.sessionId, steeringId, [{type:'text',text:'Additional guidance for this same turn: before finishing, also write guided.txt containing guided. Do not delegate.'}]);
    const results = await turns;
    assert(results.every(value => value.reason.kind === 'completed'), JSON.stringify(results));
    assert.equal((await readFile(resolve(workspace, 'one.txt'), 'utf8')).trim(), 'one');
    assert.equal((await readFile(resolve(workspace, 'two.txt'), 'utf8')).trim(), 'two');
    assert.equal((await readFile(resolve(workspace, 'guided.txt'), 'utf8')).trim(), 'guided');
    await h.observe(one.sessionId);
    const persisted = await readHistory(resolve(h.home, 'sessions'), one.sessionId, { limit: 10000 });
    const applied = persisted.events.find(event => event.type === 'user/message' && event.data?.source?.rpcId === steeringId);
    assert(applied, 'Steering must appear in persisted user input');
    assert.equal(persisted.events.filter(event => event.type === 'turn/start').length, 1, 'Steering must not create a second turn');
    report.checks.push({ name: 'real-overlap-steering-artifacts', status: 'pass', steering, appliedSeq: applied.seq });
    await writeFile(resolve(run, 'activity.json'), JSON.stringify({ events, updates }, null, 2));
    await writeFile(resolve(run, 'history-one.json'), JSON.stringify(persisted, null, 2));
    const activeTool = waitEvent(h, 'source', value => value.sessionId === one.sessionId && value.type === 'tool/call');
    const interrupted = prompt(h, one.sessionId, 'Use bash to sleep for 30 seconds then write late.txt with late. Do not delegate.');
    interrupted.catch(() => {});
    await activeTool;
    await h.interrupt(one.sessionId);
    assert.equal((await interrupted).reason.kind, 'aborted');
    assert.equal((await h2.activity(independent.sessionId)).blockers.some(b=>b.kind==='running'), false);
    report.checks.push({ name: 'session-interrupt', status: 'pass' });
    await h2.close();
    const cold = await readHistory(resolve(h2.home, 'sessions'), independent.sessionId);
    assert(cold.events.length > 0);
    const resumed = new Harness(config, h2.home, workspace, budget);
    harnesses.push(resumed); await resumed.start();
    await resumed.activate(independent.sessionId, []);
    assert.equal((await prompt(resumed, independent.sessionId, 'Reply with the single word resumed. Do not use tools.')).reason.kind, 'completed');
    report.checks.push({ name: 'cold-read-resume-real-turn', status: 'pass' });
  }
  await h.closeSession(one.sessionId);
  if (!live) assert.equal((await h2.activity(two.sessionId)).blockers.some(b=>b.kind==='running'), false);
  report.checks.push({ name: 'scoped-close', status: 'pass' });
  await h.close();
  const history = await readHistory(resolve(h.home, 'sessions'), one.sessionId);
  assert.equal(history.header.id, one.sessionId);
  report.checks.push({ name: 'cold-persistence-without-agent', status: 'pass', events: history.events.length });
} catch (error) {
  report.checks.push({ name: 'qualification', status: 'fail', error: error.message });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await Promise.all(harnesses.map(h => h.close()));
  if (deadline) clearTimeout(deadline);
  if (ledger) report.budget = ledger.close();
  await writeFile(resolve(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence: ${run}`);
}
