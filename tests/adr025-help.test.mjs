import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {commands,discovery} from '../src/cli/contracts.ts';
import {parseArguments,parseInvocation} from '../src/cli/client.ts';
import {helpEntries} from '../src/cli/help-catalog.ts';
import {HelpView,helpOutput,helpPolicy,renderHelp} from '../src/cli/help.ts';

const executable=fileURLToPath(new URL('../bin/harnessctl',import.meta.url));
function help(argv){const {words,flags}=parseArguments(argv);return helpOutput(words,flags);}
const view=argv=>HelpView.parse(JSON.parse(help([...argv,'--json'])).data);
const parse=(argv,input)=>{const {words,flags}=parseArguments(argv);return parseInvocation(words,flags,input);};
const id='11111111-1111-4111-8111-111111111111';
const request='33333333-3333-4333-8333-333333333333';

test('progressive help narrows four categories and resources without exposing schemas',()=>{
 const root=view([]);assert.equal(root.kind,'root');assert.equal(root.categories.length,4);
 assert.deepEqual(view(['help']),root);assert.deepEqual(view(['--help']),root);
 const covered=[];
 for(const {selector} of root.categories){const category=view(['help',selector]);assert.equal(category.kind,'inventory');assert(category.commands.every(command=>command.category===selector));covered.push(...category.commands.map(c=>c.command.replace(' ','.')));}
 assert.deepEqual(covered.sort(),Object.keys(commands).sort(),'Exactly one category must contain every executable command');
 const workers=view(['worker','--help']);assert(workers.commands.every(c=>c.command.startsWith('worker ')));assert(workers.commands.some(c=>c.command==='worker overview'));
 const target=view(['worker','send','--help']);assert.equal(target.kind,'command');assert.equal(target.command,'worker send');assert.match(target.result,/acceptance.*not.*completion/);
 for(const compact of [root,workers,target])assert(!JSON.stringify(compact).includes('"$schema"'));
});

test('every authored example passes the execution parser without installation or dispatch',()=>{
 assert.deepEqual(Object.keys(helpEntries).sort(),Object.keys(commands).sort());
 for(const [name,entry] of Object.entries(helpEntries)){
  const parsed=parse([...name.split('.'),...entry.args],entry.input);
  assert.equal(parsed.request.command.kind,name);
  const compact=view([...name.split('.'),'--help']);
  assert(compact.example.command.startsWith(`harnessctl ${name.replace('.',' ')}`));
  assert.match(compact.example.placeholders,/replace/i);
 }
});

test('caller requirements, defaults, output files and cross-field conditions match execution',()=>{
 const get=view(['worker','get','--help']);assert.deepEqual(get.inputs.find(v=>v.name==='--options'),{name:'--options',type:'boolean',required:false,default:false});
 const schema=JSON.parse(help(['worker','get','--help','--schema','--json']));assert.deepEqual(schema.commands['worker.get'].input.required,['target']);
 assert.equal(parse(['worker','get',id]).request.command.input.options,false);
 for(const name of ['worker.evidence','binding.create']){
  const output=view([...name.split('.'),'--help']).clientInputs.find(v=>v.name==='--output');assert.equal(output.required,true);
  const entry=helpEntries[name],args=entry.args.slice();args.splice(args.indexOf('--output'),2);
  assert.throws(()=>parse([...name.split('.'),...args],entry.input),/requires --output/);
 }
 assert.equal(view(['worker','send','--help']).clientInputs.find(v=>v.name==='--request-id').required,false);
 assert(parse(['worker','send',id,'--text','Hello']).request.requestId);
 assert.throws(()=>parse(['worker','close',id]),/request-id/);
 assert.throws(()=>parse(['worker','create','--node',id,'--title','Analyst','--environment','analysis','--request-id',request]),/exact revision/);
 assert.throws(()=>parse(['worker','update',id,'--title','Analyst','--model','model','--request-id',request]),/exactly one/);
 assert.throws(()=>parse(['worker','overview','--limit','2']),/section/);
 const publish=helpEntries['environment.publish'];assert.equal(parse(['environment','publish','--preview','--input','-'],publish.input).request.requestId,undefined);
 assert.match(view(['environment','publish','--help']).constraints.join(' '),/required unless --preview/);
 assert.match(view(['checkpoint','publish','--help']).constraints.join(' '),/shared unfinished/);
});

test('search understands concrete intents, orders deterministically and pages complete matches',()=>{
 for(const [query,expected] of [['save progress','checkpoint publish'],['colleagues','worker list'],['independent workspace','node create'],['inherit','node create'],['inheritance','node create'],['branch','node create'],['fork','node create'],['snapshot','checkpoint publish'],['snapshot','node create'],['from-checkpoint','node create'],['node from-checkpoint','node create'],['permission','worker respond'],['tool connection','capability import'],['lost response','operation get']]){
  const search=view(['help','--search',query]);assert(search.commands.some(c=>c.command===expected),query);assert.equal(search.kind,'search');assert(!JSON.stringify(search).includes('"inputs"'));
 }
 assert.equal(view(['help','--search','WORKER.GET']).commands[0].command,'worker get');
 assert.equal(view(['help','--search','from-checkpoint']).commands[0].command,'node create');
 assert.equal(view(['help','--search','inheritance']).commands[0].command,'node create');
 assert.equal(view(['help','--search','inher']).total,0,'Discovery must not turn arbitrary prefixes into fuzzy matches');
 const restricted=view(['help','research','--search','workspace']);assert(restricted.commands.every(c=>c.category==='research'));
 const whole=view(['help','--search','worker','--limit',String(helpPolicy.searchMax)]);
 let after=0;const collected=[];let catalog;
 do{const page=view(['help','--search','worker','--limit','2','--after',String(after)]);assert.equal(page.returned,page.commands.length);assert.equal(page.total,whole.total);catalog??=page.catalog;assert.equal(page.catalog,catalog);collected.push(...page.commands);after=page.continuation;}while(after!==null);
 assert.deepEqual(collected,whole.commands);assert.deepEqual(view(['help','--search','worker','--limit','2']),view(['help','--search','worker','--limit','2']));
 const noMatch=view(['help','--search','nonexistentxyz']);assert.equal(noMatch.total,0);assert.equal(noMatch.continuation,null);assert.match(noMatch.hint,/Broaden/);
 const beyond=view(['help','--search','worker','--after','10000']);assert.equal(beyond.returned,0);assert.equal(beyond.continuation,null);
});

test('details and explicit schemas preserve selected scope and reject ambiguity',()=>{
 for(const argv of [['help','--search',''],['help','--search',' '.repeat(4)],['help','--schema','--search','worker'],['worker','send','--help','--schema','--details'],['help','workers','--details'],['help','--limit','2'],['help','--search','worker','--limit','0'],['help','--search','worker','--limit',String(helpPolicy.searchMax+1)],['help','--search','worker','--after','-1'],['help','unknown'],['unknown','--help'],['worker','unknown','--help'],['help','--search','x'.repeat(helpPolicy.queryBytes+1)]])assert.throws(()=>help(argv),undefined,argv.join(' '));
 const details=view(['worker','send','--help','--details']);assert.match(details.details.join(' '),/<<'POLARITON_REPORT'/);assert.match(details.details.join(' '),/original.*request ID/);assert.equal(view(['worker','send','--help']).details,undefined);
 const workers=JSON.parse(help(['worker','--help','--schema','--json']));assert(Object.keys(workers.commands).every(n=>n.startsWith('worker.')));
 const research=JSON.parse(help(['help','research','--schema','--json']));assert(research.commands['node.create']);assert(!research.commands['worker.get']);
 const full=JSON.parse(help(['--help','--schema','--json']));assert.deepEqual(Object.keys(full.commands).sort(),Object.keys(commands).sort());assert.deepEqual(full,discovery());
 for(const contract of Object.values(full.commands)){assert(contract.input);assert(contract.output);}
 const selected=help(['worker','create','--help','--schema']);
 assert(selected.indexOf('"input"')<selected.indexOf('"responses"'),'Invocation input must precede generic response envelopes');
 assert.deepEqual(JSON.parse(selected),discovery(['worker.create']),'Reordering must preserve the full selected schema');
});

test('activation discovery leads to the first task and unknown verbs recover within their resource',()=>{
 for(const query of ['start inactive worker','activate worker','start coworker','activate']){
  const found=view(['help','--search',query]);assert.equal(found.commands[0].command,'worker send',query);
  assert.match(found.commands[0].purpose,/starts.*inactive worker automatically/);
 }
 assert.match(view(['worker','create','--help']).constraints.join(' '),/first task.*worker send.*starts the worker automatically/);
 assert.match(view(['worker','resume','--help']).purpose,/without new input|no new input/);
 for(const resource of ['worker','checkpoint','environment']){
  for(const args of [[resource,'activate','--help'],['help',resource,'activate']])assert.throws(()=>help(args),new RegExp(`harnessctl ${resource} --help`));
  assert.throws(()=>parse([resource,'nonexistent']),new RegExp(`harnessctl ${resource} --help`));
  const child=spawnSync(process.execPath,[executable,resource,'nonexistent'],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,2);assert.match(JSON.parse(child.stdout).error.message,new RegExp(`harnessctl ${resource} --help`));
 }
 assert.throws(()=>help(['unknown','verb','--help']),/Use harnessctl help,/);
});

test('compact help exposes reply routing, receipt expansion and creation defaults without a schema read',()=>{
 const send=view(['worker','send','--help']);
 assert.match(send.constraints.join(' '),/Normal assistant replies stay in your conversation/);
 assert.match(send.constraints.join(' '),/authenticated sender/);
 assert.match(send.constraints.join(' '),/Do not poll history or status/);
 assert.match(view(['worker','history','--help']).result,/inspection and troubleshooting/);
 assert.match(view(['worker','create','--help']).constraints.join(' '),/configured default, not the creator/);
 assert.match(view(['checkpoint','publish','--help']).constraints.join(' '),/do not advance ordinary Git HEAD or change the index/);
 for(const name of Object.keys(commands)){
  const command=view([...name.split('.'),'--help']);
  assert(command.clientInputs.some(field=>field.name==='--json'),name);
  if((commands[name].mutation&&name!=='canvas.move')||name==='operation.get')assert(command.clientInputs.some(field=>field.name==='--details'),name);
 }
 assert.match(view([]).conventions.join(' '),/--flag VALUE, not --flag=VALUE/);
});

test('every rendering obeys release budgets and text/JSON contain the same semantic view',()=>{
 const cases=[[[],helpPolicy.rootBytes],...['research','workers','tools','system'].map(scope=>[['help',scope],helpPolicy.inventoryBytes]),...new Set(Object.keys(commands).map(n=>n.split('.')[0]))].map(item=>typeof item==='string'?[[item,'--help'],helpPolicy.inventoryBytes]:item);
 for(const name of Object.keys(commands)){cases.push([[...name.split('.'),'--help'],helpPolicy.commandBytes]);cases.push([[...name.split('.'),'--help','--details'],helpPolicy.detailsBytes]);}
 cases.push([['help','--search','worker','--limit',String(helpPolicy.searchMax)],helpPolicy.searchBytes]);
 for(const [args,budget] of cases){const model=view(args);assert.equal(help(args),renderHelp(model,false));assert.equal(help([...args,'--json']),renderHelp(model,true));for(const json of [false,true])assert(Buffer.byteLength(help([...args,...json?['--json']:[]]))<=budget,args.join(' '));}
 for(const json of [false,true])assert(Buffer.byteLength(help(['--help','--schema',...json?['--json']:[]]))<=helpPolicy.schemaBytes);
});

test('the packaged executable discovers help with closed stdin, unrelated cwd and malformed config',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adr025-help-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=join(root,'broken.json');await writeFile(config,'not configuration JSON');
 const env={...process.env,HARNESSCTL_CONFIG:config,HARNESSCTL_TOKEN:'revoked',DSH_HARNESSCTL_TOKEN:'revoked',DSH_SHELL:'bash'};
 for(const args of [[],['help'],['worker','--help'],['worker','overview','--help'],['help','--search','save progress'],['--help','--schema','--json']]){
  const child=spawnSync(process.execPath,[executable,'--config',config,...args],{cwd:root,env,encoding:'utf8',input:'',timeout:10000});assert.equal(child.status,0,child.stdout+child.stderr);assert(child.stdout.length);assert(!child.stdout.includes('AUTH_REQUIRED'));
 }
 const invalid=spawnSync(process.execPath,[executable,'help','unknown','--json'],{cwd:root,env,encoding:'utf8',input:'',timeout:10000});assert.equal(invalid.status,2);assert.equal(JSON.parse(invalid.stdout).error.code,'USAGE');assert(Buffer.byteLength(invalid.stdout)<helpPolicy.rootBytes);
});
