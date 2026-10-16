import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRelease} from '../harness/release.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const violations=[];
const publicHarness=new Set(['contracts.ts','settings.ts','client.ts','history.ts','catalog.ts','release.ts','budget.mjs','providers.ts','provider-contracts.ts','mcp-contracts.ts','mcp-validation.ts']);
const publicPresenter=new Set(['presentation.ts','views.tsx']);
const protocol=/(['"])(?:session\/(?:new|resume|list|set_config_option|request_permission)|activationReady|mcpPrepare|mcpClear|mcpStatus|mcpContext|residencyReserve|residencyCommit|residencyRelease)\1/;
const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory()){await walk(path);continue;}
  if(!/\.(?:ts|tsx|mjs)$/.test(entry.name))continue;
  const name=relative(root,path).split('\\').join('/'),text=await readFile(path,'utf8');
  const presenter=name.startsWith('web/src/native/');
  if(!presenter&&/@deepseek-ai\/(?:dsh|cordis)/.test(text))violations.push(`${name}: DSH belongs in the harness or presenter`);
  if(!presenter&&protocol.test(text))violations.push(`${name}: upstream protocol belongs in the harness`);
  const imports=/\b(?:from\s*|import\s*\(\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for(const [,specifier]of text.matchAll(imports)){
    if(!specifier.startsWith('.'))continue;
    const target=relative(root,resolve(dirname(path),specifier)).split('\\').join('/');
    if(target.startsWith('harness/')&&!publicHarness.has(target.slice('harness/'.length)))violations.push(`${name}: private harness import ${specifier}`);
    if(!presenter&&target.startsWith('web/src/native/')&&!publicPresenter.has(target.slice('web/src/native/'.length)))violations.push(`${name}: private presenter import ${specifier}`);
    if(target==='..'||target.startsWith('../'))violations.push(`${name}: import escapes V5`);
  }
}};
await walk(join(root,'src'));await walk(join(root,'web/src'));
const origin=JSON.parse(await readFile(join(root,'web/src/native/ORIGIN.json'),'utf8'));
for(const entry of origin.files){
  const actual=createHash('sha256').update(await readFile(join(root,entry.local))).digest('hex');
  if(actual!==entry.localSha256)violations.push(`${entry.local}: presentation provenance must be reviewed and refreshed`);
}
const mcpOrigin=JSON.parse(await readFile(join(root,'harness/native/MCP-ORIGIN.json'),'utf8'));
for(const [path,expected] of [[mcpOrigin.local,mcpOrigin.localSha256],[`node_modules/${mcpOrigin.package}/${mcpOrigin.source}`,mcpOrigin.upstreamSha256]]){
  const actual=createHash('sha256').update(await readFile(join(root,path))).digest('hex');
  if(actual!==expected)violations.push(`${path}: MCP adaptation provenance must be reviewed and refreshed`);
}
if(violations.length)throw new Error(violations.join('\n'));
await verifyRelease();
console.log('Harness ownership, presentation/MCP provenance and locked release verified.');
