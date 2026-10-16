import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crc32} from 'node:zlib';
import {prepareBundle} from '../src/environment/bundles.ts';
import {RackConfig} from '../src/environment/contracts.ts';

// A small external-format fixture builder. Stored ZIP members make malicious path
// and mode fixtures readable without depending on the extraction implementation.
function archive(entries:Array<{path:string,body:string,mode?:number}>){
  const files:Buffer[]=[],directory:Buffer[]=[];let offset=0;
  for(const entry of entries){const path=Buffer.from(entry.path),body=Buffer.from(entry.body),crc=crc32(body),header=Buffer.alloc(30),central=Buffer.alloc(46);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(path.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(3*256+20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(path.length,28);central.writeUInt32LE(((entry.mode??0o100644)*65536)>>>0,38);central.writeUInt32LE(offset,42);files.push(header,path,body);directory.push(central,path);offset+=header.length+path.length+body.length;}
  const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...files,dir,end]);
}
const manifest={manifest_version:'0.3',name:'fixture',version:'1.0.0',server:{type:'node',entry_point:'server.js',mcp_config:{command:'node',args:['${__dirname}/server.js','${user_config.roots}']}},user_config:{roots:{type:'directory',multiple:true,required:true}},compatibility:{platforms:[process.platform],runtimes:{node:'>=24.0.0'}}};
async function fixture(t:TestContext,entries:Array<{path:string,body:string,mode?:number}>,limits:Record<string,unknown>={}){
  const root=await mkdtemp(join(tmpdir(),'polariton-bundle-')),bytes=archive(entries),server=createServer((_request,response)=>response.end(bytes));await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});});const address=server.address();if(!address||typeof address==='string')throw Error();
  return {root,config:RackConfig.parse({stateRoot:root,socketPath:join(root,'socket'),...limits}),input:{url:`http://127.0.0.1:${address.port}/fixture.mcpb`,sha256:createHash('sha256').update(bytes).digest('hex'),configuration:{roots:['${POLARITON_WORKSPACE}']}}};
}
const normal=()=>[{path:'manifest.json',body:JSON.stringify(manifest)},{path:'server.js',body:'console.log("fixture");'}];
test('digest-pinned bundles bind declared configuration without executing manifest commands',async t=>{
  const f=await fixture(t,normal()),result=await prepareBundle(f.input,join(f.root,'installation'),f.config,new AbortController().signal);assert.equal(result.runtime,'node');assert.equal(result.version,'1.0.0');assert.deepEqual(result.args,[join(f.root,'installation','server.js'),'${POLARITON_WORKSPACE}']);assert.equal(await readFile(result.entry,'utf8'),'console.log("fixture");');
});
test('bundle integrity, missing configuration and incompatible platform fail independently',async t=>{
  const f=await fixture(t,normal());await assert.rejects(prepareBundle({...f.input,sha256:'0'.repeat(64)},join(f.root,'hash'),f.config,new AbortController().signal),{code:'BUNDLE_INTEGRITY'});
  await assert.rejects(prepareBundle({...f.input,configuration:{}},join(f.root,'config'),f.config,new AbortController().signal),{code:'BUNDLE_CONFIGURATION'});
  const g=await fixture(t,[{path:'manifest.json',body:JSON.stringify({...manifest,compatibility:{platforms:['unsupported']}})},{path:'server.js',body:''}]);await assert.rejects(prepareBundle(g.input,join(g.root,'platform'),g.config,new AbortController().signal),{code:'BUNDLE_PLATFORM'});
});
test('bundle extraction rejects traversal, links, duplicate paths and decompressed byte excess',async t=>{
  for(const bad of [{path:'../outside',body:'escape'},{path:'link',body:'/outside',mode:0o120777},{path:'server.js',body:'duplicate'}]){
    const f=await fixture(t,[...normal(),bad]);await assert.rejects(prepareBundle(f.input,join(f.root,'installation'),f.config,new AbortController().signal),error=>['BUNDLE_PATH','BUNDLE_ARCHIVE'].includes((error as {code:string}).code));
  }
  const f=await fixture(t,normal(),{maxPackageBytes:32});await assert.rejects(prepareBundle(f.input,join(f.root,'limit'),f.config,new AbortController().signal),{code:'PACKAGE_LIMIT'});
});
