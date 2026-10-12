import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {loadConfig,sourceRoot} from '../src/config.ts';
import {loadRackConfig} from '../src/environment/daemon.ts';

/** Disposable real-container acceptance of the executable and independent consumer.
 * No provider runs here. All owner actions use harnessctl, including restart/cleanup. */
const root=sourceRoot,evidence=join(root,'docs/evidence/adr012');
await mkdir(join(root,'.local/adr012-rack'),{recursive:true});
const base=await mkdtemp(join(root,'.local/adr012-rack/run-')),repository=join(base,'capability');await mkdir(repository);
const config=await loadConfig(join(root,'config/adr012-app.json')),rack=await loadRackConfig(config.environmentConfig);
const rackPath=join(base,'environment.json'),appPath=join(base,'app.json');
await writeFile(rackPath,JSON.stringify({...rack,stateRoot:join(base,'rack'),socketPath:`/tmp/adr012-rack-${process.pid}.sock`}));
await writeFile(appPath,JSON.stringify({...config,configPath:appPath,verification:false,campaign:undefined,stateRoot:join(base,'main'),environmentConfig:rackPath}));
const report={startedAt:new Date().toISOString(),providerRequests:0,commands:[],passed:false},exec=promisify(execFile);let consumer;
const scrub=value=>JSON.parse(JSON.stringify(value).replaceAll(root,'<V5>'));
async function cli(command,input={},mutation=false,extra=[],expectedExit=0){
 const args=['--config',appPath,...command.split('.'),'--input','-',...(mutation?['--request-id',typeof mutation==='string'?mutation:randomUUID()]:[]),...extra,...(mutation||command==='operation.get'?['--details']:[])];
 const child=spawn(join(root,'bin/harnessctl'),args,{cwd:base,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.stdin.end(JSON.stringify(input));
 const timer=setTimeout(()=>child.kill('SIGTERM'),rack.operationTimeoutMs+rack.startupTimeoutMs);const code=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});clearTimeout(timer);
 const value=JSON.parse(stdout);report.commands.push({command,input,code,result:value,stderr});await writeFile(join(evidence,'managed-cli.json'),JSON.stringify(scrub(report),null,2));assert.equal(code,expectedExit,JSON.stringify(value));return value.data;
}
const git=async(...args)=>(await exec('git',['-C',repository,...args],{timeout:rack.operationTimeoutMs})).stdout.trim();
try{
 for(const name of ['fixture.mjs','server.mjs','test.mjs','version.json','polariton-capability.json','package.json','package-lock.json'])await copyFile(join(root,'tests/fixtures/adr010',name),join(repository,name));
 await copyFile(join(root,'environment/server.mjs'),join(repository,'server-support.mjs'));
 await git('init');await git('add','.');await git('-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','ADR012 managed fixture R1');
 const commit=await git('rev-parse','HEAD');
 await cli('daemon.start',{target:'environment',detach:true},true);await cli('daemon.status',{target:'environment'});
 const capability=(await cli('capability.register',{repository},true)).result;
 const release=(await cli('release.install',{target:capability.id,commit},true)).result;
 assert.equal((await cli('release.get',{target:release.id})).provenance.commit,commit);
 const component={id:'measurement',name:'Measurement fixture',releaseId:release.id,configuration:{role:'measurement',seed:'adr012-independent-fixture',slowMs:1000}};
 const mount=(await cli('mount.create',{component},true)).result;
 await cli('mount.list');assert.equal((await cli('mount.get',{target:mount.id})).state,'running');await cli('mount.observe',{target:mount.id});
 const collisionId=randomUUID(),collisionPath=join(base,'existing-output.json'),recoveredPath=join(base,'recovered-output.json');
 const collisionInput={mount:mount.id,principal:'output-recovery-verifier',access:'observe'};
 await writeFile(collisionPath,'caller-owned content\n');
 const retained=await cli('binding.create',collisionInput,collisionId,['--output',collisionPath],6);
 const failedOutput=report.commands.at(-1).result;
 assert.equal(failedOutput.error.code,'OUTPUT_FAILED');assert.equal(failedOutput.error.operation,retained.reference);
 assert.equal(retained.connection,undefined);assert.equal(await readFile(collisionPath,'utf8'),'caller-owned content\n');
 assert.equal((await cli('operation.get',{target:retained.reference})).state,'succeeded');
 const recovered=await cli('binding.create',collisionInput,collisionId,['--output',recoveredPath]);
 assert.equal(recovered.requestId,retained.requestId);assert(JSON.parse(await readFile(recoveredPath,'utf8')).url);
 assert.equal((await cli('binding.list')).items.filter(value=>value.id===collisionId).length,1);
 await cli('binding.release',{target:collisionId},true);
 const output=join(base,'connection.json'),binding=await cli('binding.create',{mount:mount.id,principal:'external-verifier',access:'call'},true,['--output',output]);
 const connection=JSON.parse(await readFile(output,'utf8'));consumer=new Client({name:'adr012-independent-consumer',version:'1'},{versionNegotiation:{mode:'auto'}});
 await consumer.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:Object.fromEntries(connection.headers.map(v=>[v.name,v.value]))}}));
 const result=await consumer.callTool({name:'measure',arguments:{sample:'adr012-native-consumer',mode:'normal'}});assert(!result.isError);report.consumer=result;
 await consumer.close();consumer=null;await cli('binding.list');await cli('binding.get',{target:binding.requestId});await cli('binding.release',{target:binding.requestId},true);
 await writeFile(join(repository,'version.json'),JSON.stringify({version:2}));await git('add','version.json');await git('-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','ADR012 managed fixture R2');
 const release2=(await cli('release.install',{target:capability.id,commit:await git('rev-parse','HEAD')},true)).result;
 const replace=await cli('mount.replace',{target:mount.id,release:release2.id},true);const deadline=Date.now()+rack.startupTimeoutMs;
 while((await cli('mount.get',{target:mount.id})).state!=='running'){assert(Date.now()<deadline);await delay(rack.monitorMs);}
 await cli('operation.get',{target:replace.reference});await cli('mount.observe',{target:mount.id,uri:'fixture://capability'});
 await cli('mount.stop',{target:mount.id},true);assert.equal((await cli('mount.get',{target:mount.id})).state,'stopped');
 // Crash after a committed immutable result; a fresh process must recover exactly it.
 const status=await cli('daemon.status',{target:'environment'});process.kill(status.environment.pid,'SIGKILL');await delay(config.interruptPollMs);
 await cli('daemon.start',{target:'environment',detach:true},true);assert.equal((await cli('release.get',{target:release.id})).release.commit,commit);
 report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{await consumer?.close();try{await cli('daemon.stop',{target:'environment'},true);}catch(error){report.cleanupError=error.message;report.passed=false;process.exitCode=1;}report.finishedAt=new Date().toISOString();await writeFile(join(evidence,'managed-cli.json'),JSON.stringify(scrub(report),null,2)+'\n');console.log(JSON.stringify({passed:report.passed,error:report.error,cleanupError:report.cleanupError}));}
