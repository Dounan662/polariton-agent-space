import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {EnvironmentRack} from '../src/environment/rack.ts';
import {loadRackConfig} from '../src/environment/daemon.ts';
import {digest} from '../src/environment/storage.ts';

// Requalify retained live-agent commits after provenance hardening, with no model calls.
const root=fileURLToPath(new URL('../',import.meta.url)),attempt=2;
const previous=JSON.parse(await readFile(join(root,`.local/adr009/attempt-${attempt}/inventory.json`),'utf8'));
const source=join(root,`.local/adr009/attempt-${attempt}/builder`);
const stateRoot=await mkdtemp(join(root,'.local/adr009/retention-'));
const config={...await loadRackConfig(),stateRoot};
const rack=await new EnvironmentRack(config).open(),checks=[];
try{
  await rack.execute({kind:'capability.register',operationId:'register',id:'generated',repository:source});
  for(const version of [1,2]){
    const original=previous.releases.find(r=>r.id===`live-r${version}-${attempt}`);
    const release=await rack.execute({kind:'release.install',operationId:`retained-r${version}`,packageId:'generated',commit:original.commit});
    const provenance=await rack.provenance(release.id),archive=await readFile(join(stateRoot,'releases',release.id,'source.tar'));
    assert.equal(provenance.sourceDigest,digest(archive));
    assert.deepEqual(archive,execFileSync('git',['-C',source,'archive','--format=tar',original.commit],{maxBuffer:config.maxSourceBytes}));
    assert.equal(provenance.commit,original.commit);assert.deepEqual(provenance.manifest,original.manifest);
    assert.deepEqual(provenance.builds.map(b=>b.argv),original.manifest.build);assert(provenance.builds.every(b=>typeof b.output==='string'));
    assert(provenance.dependencies.capabilities['node_modules/@modelcontextprotocol/server']);
    await mkdir(join(root,'docs/evidence/adr009/generated-source'),{recursive:true});
    await writeFile(join(root,`docs/evidence/adr009/generated-source/r${version}.tar`),archive);
    await writeFile(join(root,`docs/evidence/adr009/generated-source/r${version}-provenance.json`),JSON.stringify(provenance,null,2)+'\n');
    checks.push({version,status:'pass',commit:original.commit,releaseId:release.id,sourceDigest:provenance.sourceDigest,artifactDigest:release.artifactDigest});
  }
}finally{await rack.close();}
await writeFile(join(root,'docs/evidence/adr009/retention.json'),JSON.stringify({passed:true,providerRequests:0,checks},null,2)+'\n');
console.log(JSON.stringify({passed:true,checks}));
