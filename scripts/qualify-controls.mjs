import {nativeTurn} from './native-turn.mjs';
import {loadConfig,CampaignConfig,QualificationConfig} from '../src/config.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from '../harness/client.ts';
import { VerificationBudget } from '../harness/budget.mjs';
import { readHistory } from '../harness/history.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = resolve(root, process.argv[2]);
if (!run.startsWith(resolve(root, '.local/qualification') + '/')) throw new Error('Expected a local qualification run');
const campaignId=process.argv.includes('--campaign')?process.argv[process.argv.indexOf('--campaign')+1]:undefined;
if(campaignId&&!['adr006','adr007'].includes(campaignId))throw new Error('Unknown campaign');
const config=campaignId?await loadConfig(resolve(root,`config/${campaignId}-app.json`)):{...await loadConfig(),...QualificationConfig.parse(JSON.parse(await readFile(resolve(root,'config/qualification.json'),'utf8'))),verification:true};
const limits=campaignId?CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8'))):config;
const ledgerPath=campaignId?resolve(dirname(config.campaign),limits.ledger):resolve(root,'.local/verification-budget.sqlite');
const old = JSON.parse(await readFile(resolve(run, 'report.json'), 'utf8'));
const activity = JSON.parse(await readFile(resolve(run, 'activity.json'), 'utf8'));
const one = old.checks[0].sessions[0];
const two = activity.events.find(event => event.sessionId !== one).sessionId;
const ledger = new VerificationBudget(ledgerPath, process.argv.includes('--rerun')?{...limits,reserveRequests:0,reserveMs:0}:limits);
const peers = ['dsh', 'dsh2'].map(home => new Harness(config, resolve(run, home), resolve(run, 'workspace'), async () => ledger.reserve()));
const report = { checks: [] };
const deadline = setTimeout(() => peers.forEach(h => {void h.close().catch(error=>console.error(error));}), ledger.remainingMs);
function observed(h, name, predicate) {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { h.off(name, listener); reject(new Error(`Missing ${name}`)); }, config.requestTimeoutMs);
    const listener = value => { if (predicate(value)) { clearTimeout(timer); h.off(name, listener); accept(value); } };
    h.on(name, listener);
  });
}
const prompt = (h, id, text) => nativeTurn(h, id, text, config.requestTimeoutMs);
try {
  await Promise.all(peers.map(h => h.start()));
  await Promise.all(peers.map((h, i) => h.activate([one, two][i], [])));
  if (!process.argv.includes('--permission-only')) {
  const barriers = peers.map((h, i) => observed(h, 'source', e => e.sessionId === [one, two][i] && e.type === 'tool/call'));
  const turn1 = prompt(peers[0], one, 'Use bash to sleep 30 seconds then write stopped.txt containing stopped. Do not delegate.');
  const turn2 = prompt(peers[1], two, 'Use bash to sleep 8 seconds then write continued.txt containing continued. Do not delegate.');
  turn1.catch(() => {}); turn2.catch(() => {});
  await Promise.all(barriers);
  await peers[0].interrupt(one);
  assert.equal((await turn1).reason.kind, 'aborted');
  assert.equal((await turn2).reason.kind, 'completed');
  assert.equal((await readFile(resolve(run, 'workspace/continued.txt'), 'utf8')).trim(), 'continued');
  report.checks.push({ name: 'interrupt-one-while-other-continues', status: 'pass' });
  }
  const permission = observed(peers[0], 'permission', p => p.sessionId === one);
  const denied = prompt(peers[0], one, 'This is an approval-interface test. Call bash once with command printf "probe\\n" > ../permission-probe.txt, sandbox_permissions="danger-full-access", and justification="Synthetic qualification permission probe". The client will reject the request. After rejection report denied and stop. Do not retry, delegate, or use another tool.');
  denied.catch(() => {});
  const request = await Promise.race([permission, denied.then(() => { throw new Error('Turn ended without permission exchange'); })]);
  await denied;
  report.checks.push({ name: 'scoped-permission-rejection', status: 'pass', sessionId: request.sessionId, toolCallId: request.toolCall.toolCallId });
  for (const [i, h] of peers.entries()) {
    await h.close();
    const saved = await readHistory(resolve(h.home, 'sessions'), [one, two][i], { limit: 10000 });
    await writeFile(resolve(run, `controls-history-${i}.json`), JSON.stringify(saved, null, 2));
  }
} catch (error) {
  report.checks.push({ name: 'controls', status: 'fail', error: error.message });
  process.exitCode = 1;
} finally {
  await Promise.all(peers.map(h => h.close())); clearTimeout(deadline);
  report.budget = ledger.close();
  await writeFile(resolve(run, process.argv.includes('--permission-only') ? 'permission-report.json' : 'controls-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
