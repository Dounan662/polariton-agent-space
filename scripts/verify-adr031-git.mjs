/** Exercise committed authored tools through the same preparation/validation contract. */
import assert from 'node:assert/strict';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {loadRackConfig} from '../src/environment/daemon.ts';
import {EnvironmentRack} from '../src/environment/rack.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {PreparationInput} from '../src/environment/preparation-contracts.ts';
assert(process.argv.includes('--live'),'Explicit --live is required');
const run=resolve('.local/adr031-git',new Date().toISOString().replaceAll(':','-')),source=join(run,'authored-tool');
await mkdir(join(source,'environment'),{recursive:true});
for(const name of ['package.json','package-lock.json'])await copyFile(join('tests/fixtures/adr009',name),join(source,name));
await copyFile('environment/server.mjs',join(source,'environment/server.mjs'));
await writeFile(join(source,'server.mjs'),`import {McpServer} from '@modelcontextprotocol/server';\nimport {z} from 'zod';\nimport {serveCapability} from './environment/server.mjs';\nawait serveCapability({createServer(){const server=new McpServer({name:'authored-arithmetic',version:'1.0.0'});server.registerTool('multiply',{inputSchema:z.object({a:z.number(),b:z.number()})},({a,b})=>({content:[{type:'text',text:String(a*b)}]}));return server;}});\n`);
const image='node@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152';
await writeFile(join(source,'polariton-capability.json'),JSON.stringify({format:1,name:'Authored arithmetic',description:'ADR031 committed tool acceptance',image,build:[['npm','ci','--ignore-scripts','--omit=dev','--cache','/tmp/npm']],entrypoint:['node','server.mjs'],lockfiles:['package-lock.json'],configSchema:{type:'object',additionalProperties:false},mcpPath:'/mcp',port:8080,state:'scratch'}));
const config=RackConfig.parse({...await loadRackConfig(),stateRoot:join(run,'environment'),socketPath:join(run,'environment.sock'),operationTimeoutMs:900000});
const execute=promisify(execFile),git=async(...args)=>(await execute('git',['-C',source,...args],{timeout:config.operationTimeoutMs})).stdout.trim();
await git('init','--quiet');await git('add','.');await git('-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','--quiet','-m','Committed authored MCP tool');
const commit=await git('rev-parse','HEAD');await writeFile(join(source,'uncommitted-sentinel.txt'),'Must not enter artifact');
const rack=await new EnvironmentRack(config).open(),evidence={source:'committed disposable Git package',commit,image,passed:false};
try{
 const prepared=await rack.execute({kind:'environment.prepare',operationId:randomUUID(),input:PreparationInput.parse({name:'Authored arithmetic',components:[{id:'arithmetic',name:'Authored arithmetic',source:{kind:'git',directory:source,commit},runtime:{kind:'container'},connection:{kind:'http'},requirements:{},authentication:{kind:'none'},checks:[{name:'multiply',effects:'read',steps:[{tool:'multiply',arguments:{a:6,b:7}}]}]}]})});
 evidence.preparation=prepared;assert.equal(prepared.status,'ready');
 evidence.validation=await rack.execute({kind:'environment.validate',operationId:randomUUID(),input:{target:prepared.environmentId,revision:prepared.revisionId,check:'multiply'}});
 assert.equal(evidence.validation.components[0].check.status,'passed');assert.equal(evidence.validation.components[0].cleanup,'settled');
 const releaseId=prepared.components[0].capabilityId;
 evidence.provenance=await rack.provenance(releaseId);
 const archive=await execute('tar',['tf',join(config.stateRoot,'releases',releaseId,'source.tar')]);assert(!archive.stdout.includes('uncommitted-sentinel'));
 evidence.passed=true;
}finally{
 await rack.close();evidence.finishedAt=new Date().toISOString();await mkdir('docs/evidence/adr031',{recursive:true});await writeFile('docs/evidence/adr031/git.json',JSON.stringify(evidence,null,2).replaceAll(source,'<DISPOSABLE_GIT_SOURCE>').replaceAll(run,'<DISPOSABLE_RUN>')+'\n');
}
console.log(JSON.stringify({passed:evidence.passed,evidence:'docs/evidence/adr031/git.json'}));
