import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {releaseInputs,verifyRelease} from '../harness/release.ts';
import {sourceRoot} from '../src/config.ts';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'polariton-release-contract-'));
  for(const file of ['package.json','package-lock.json','web/src/native/ORIGIN.json','harness/qualification.json']){
    await mkdir(dirname(join(root,file)),{recursive:true});await copyFile(join(sourceRoot,file),join(root,file));
  }
  const manifest=await releaseInputs(root);
  await mkdir(join(root,'harness'),{recursive:true});await writeFile(join(root,'harness/release.json'),JSON.stringify(manifest));
  for(const [path,entry]of Object.entries(manifest.dependencies)){
    await mkdir(join(root,path),{recursive:true});await writeFile(join(root,path,'package.json'),JSON.stringify({version:entry.version}));
  }
  return {root,manifest};
}

test('release preflight admits the declared combination without creating execution state',async t=>{
  const {root,manifest}=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const before=await readFile(join(root,'harness/release.json'));
  assert.deepEqual(await verifyRelease(root),manifest);
  assert.deepEqual(await readFile(join(root,'harness/release.json')),before);
});

test('release preflight rejects an installed DSH replacement before activation',async t=>{
  const {root}=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'node_modules/@deepseek-ai/dsh/package.json'),JSON.stringify({version:'99.0.0'}));
  await assert.rejects(verifyRelease(root),/dependency mismatch/);
});

test('release preflight rejects unreviewed lock or presentation changes',async t=>{
  const {root}=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'web/src/native/ORIGIN.json');await writeFile(path,(await readFile(path,'utf8'))+'\n');
  await assert.rejects(verifyRelease(root),/release inputs changed/);
});

// npm can omit a fallback optional dependency without os/cpu selectors when the
// native implementation is present. Absence is allowed; a wrong installed version is not.
test('release preflight permits omitted optional fallbacks but still requires the execution owner',async t=>{
  const {root,manifest}=await fixture();t.after(()=>rm(root,{recursive:true,force:true}));
  const optional=Object.entries(manifest.dependencies).find(([path,entry])=>path==='node_modules/@img/sharp-wasm32'&&entry.optional);
  assert(optional,'The locked image fallback is optional');
  await rm(join(root,optional[0]),{recursive:true});
  await verifyRelease(root);
  await rm(join(root,'node_modules/@deepseek-ai/dsh'),{recursive:true});
  await assert.rejects(verifyRelease(root),{code:'ENOENT'});
});
