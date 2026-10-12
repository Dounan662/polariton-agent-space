// @ts-check
import {fileURLToPath} from 'node:url';
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem';

export const inject=['skills'];
const applicationSkills=['make-polariton-tool'];
// Application instructions outrank DSH's project (100/200), runtime (250), and custom (300) roots.
const applicationRank=0;

/** Publish only Polariton's owned skill names from this installed build. Project skills
 * keep their ordinary discovery and ownership; stale same-name copies cannot
 * change the application's operating contract. Parse and validate at startup so
 * a broken package cannot silently fall back to an obsolete workspace copy. */
/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function apply(ctx){
 const lifecycle=new AbortController();
 ctx.effect(()=>()=>lifecycle.abort());
 const files=new FileSystemSkillProvider(ctx,{signal:lifecycle.signal,invalidate(){}},{
  providerName:'polariton-application',includeDefaultRoots:false,
  bundledSkillDir:fileURLToPath(new URL('../skills/',import.meta.url)),watch:false,
 });
 const definitions=new Map();
 try{
  const observed=await files.list({signal:lifecycle.signal});
  const candidates=Array.isArray(observed)?observed:observed.candidates;
  for(const name of applicationSkills){
   const candidate=candidates.find(value=>value.name===name);
   const definition=candidate&&await files.get(candidate,{signal:lifecycle.signal});
   if(!definition)throw new Error(`Required Polariton skill ${name} is missing or invalid`);
   definitions.set(name,{...definition,source:'polariton-application'});
  }
 }finally{await files.dispose();}
 ctx.skills.registerProvider(()=>({
  name:'polariton-application',
  list:async()=>[...definitions.values()].map(definition=>({...definition,rank:applicationRank,locator:definition.name})),
  get:async candidate=>definitions.get(candidate.name),
 }));
}
