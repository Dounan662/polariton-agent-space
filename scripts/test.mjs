import {readdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testConcurrency,timingProfile} from '../tests/fixtures/timing.ts';
import {temporaryDirectory} from '../tests/fixtures/storage.ts';

// Keep one complete test inventory on every host. Emulation changes the explicit
// execution budget, never which contracts are included in release qualification.
const root=fileURLToPath(new URL('../',import.meta.url));
const files=(await readdir(new URL('../tests/',import.meta.url)))
  .filter(name=>/\.test\.(?:ts|mjs)$/.test(name)).sort().map(name=>'tests/'+name);
console.log(`Test profile: ${timingProfile}; concurrency: ${testConcurrency}; files: ${files.length}`);
// Implicit app/environment defaults and direct Harness consumers are disposable,
// even when the invoking shell has a development or production data override.
const directory=await temporaryDirectory('polariton-tests-');
try{
  process.exitCode=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--test',`--test-concurrency=${testConcurrency}`,...process.argv.slice(2),...files],{
      cwd:root,stdio:'inherit',env:{...process.env,POLARITON_DATA_DIR:join(directory,'data'),DSH_HOME:join(directory,'harness')},
    });
    const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    child.once('error',reject);
    child.once('close',code=>{
      process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
      resolve(code??1);
    });
  });
}finally{
  await rm(directory,{recursive:true,force:true});
}
