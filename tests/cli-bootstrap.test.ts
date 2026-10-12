import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {test} from 'node:test';

const execute=promisify(execFile);
const executable=fileURLToPath(new URL('../bin/harnessctl',import.meta.url));

test('offline CLI discovery does not initialize daemon storage or emit its SQLite warning',async()=>{
 for(const args of [['--version'],['help'],['worker','create','--help']]){
  const {stdout,stderr}=await execute(process.execPath,[executable,...args]);
  assert(stdout.length>0);
  assert.equal(stderr,'');
 }
});

test('CLI bootstrap preserves process diagnostics',async()=>{
 const diagnostic="data:text/javascript,process.emitWarning('CLI diagnostic probe',{code:'POLARITON_TEST_WARNING'})";
 const {stdout,stderr}=await execute(process.execPath,['--import',diagnostic,executable,'--version']);
 assert.equal(JSON.parse(stdout).executable,'harnessctl');
 assert.match(stderr,/POLARITON_TEST_WARNING.*CLI diagnostic probe/);
 assert.doesNotMatch(stderr,/SQLite is an experimental feature/);
});

test('ordinary CLI validation keeps its error output without daemon storage warnings',async()=>{
 await assert.rejects(execute(process.execPath,[executable,'worker','list']),error=>{
  assert(error instanceof Error&&'stdout' in error&&'stderr' in error&&'code' in error);
  assert.equal(error.code,2);
  assert.equal(JSON.parse(String(error.stdout)).error.code,'INVALID_INPUT');
  assert.equal(error.stderr,'');
  return true;
 });
});
