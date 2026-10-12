import {open} from 'node:fs/promises';
import {OfficialManifest,RackFault,type RackConfig,type OfficialEntry} from './contracts.ts';
import {digest,json} from './storage.ts';

/** Validate the application collection before accepting traffic. Digests bind all entry metadata,
 * not just launch definitions, so a version cannot silently acquire different prerequisites. */
export async function loadOfficialCatalog(config:RackConfig,fixture?:OfficialManifest):Promise<OfficialManifest>{
 let value:unknown=fixture;
 if(value===undefined){
  const file=await open(new URL('../../catalog/official.json',import.meta.url),'r');
  try{
   const bytes=Buffer.alloc(config.maxBodyBytes+1);let bytesRead=0;
   while(bytesRead<bytes.length){const result=await file.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!result.bytesRead)break;bytesRead+=result.bytesRead;}
   if(bytesRead>config.maxBodyBytes)throw new RackFault('CATALOG_LIMIT','Official catalog exceeds the configured document bound');
   value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));
  }finally{await file.close();}
 }
 const manifest=OfficialManifest.parse(value);
 if(manifest.entries.length>config.maxCapabilities)throw new RackFault('CATALOG_LIMIT','Official catalog exceeds configured capability capacity');
 const keys=new Set<string>();
 for(const entry of manifest.entries){
  const key=`${entry.id}/${entry.version}`;
  if(keys.has(key))throw new RackFault('CATALOG_DUPLICATE','Official catalog repeats an entry version');
  keys.add(key);
  if(entry.digest!==officialDigest(entry))throw new RackFault('CATALOG_DIGEST','Official catalog entry does not match its declared digest');
 }
 return manifest;
}

/** The digest covers the normalized entry contract excluding its digest field. */
export function officialDigest(entry:Omit<OfficialEntry,'digest'>|OfficialEntry){const {digest:_digest,...content}=entry as OfficialEntry;return digest(json(content));}
