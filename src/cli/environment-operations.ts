import type {EnvironmentRack} from '../environment/rack.ts';
import {RackFault,type Command} from '../environment/contracts.ts';
import type {Actor} from '../caller.ts';
import type {Request} from './contracts.ts';

/** Translate public capability vocabulary at the rack boundary; every effect remains rack-owned. */
export async function environmentOperation(rack:EnvironmentRack,request:Request,actor:Actor):Promise<unknown>{
 const c=request.command,id=request.requestId!;
 let command:Command|undefined;
 switch(c.kind){
  case 'catalog.list':return rack.catalog(c.input.after,c.input.limit);
  case 'catalog.get':return rack.catalogEntry(c.input.target);
  case 'catalog.provision':command={kind:c.kind,operationId:id,entryId:c.input.target,version:c.input.version,install:c.input.install};break;
  case 'capability.preview':return rack.preview(c.input);
  case 'capability.get':return rack.capability(c.input.target,c.input.revision);
  case 'capability.register':command={kind:c.kind,operationId:id,repository:c.input.repository};break;
  case 'capability.import':command={kind:c.kind,operationId:id,entries:c.input.entries};break;
  case 'capability.revise':command={kind:c.kind,operationId:id,id:c.input.target,expectedBase:c.input.expectRevision,entry:c.input.entry};break;
  case 'capability.add':command={kind:c.kind,operationId:id,input:c.input};break;
  case 'capability.complete':command={kind:c.kind,operationId:id,input:c.input};break;
  case 'capability.authenticate':command={kind:c.kind,operationId:id,id:c.input.target,expectedBase:c.input.expectRevision,authentication:c.input.authentication};break;
  case 'release.install':command={kind:c.kind,operationId:id,packageId:c.input.target,commit:c.input.commit};break;
  case 'environment.publish':{
   command={kind:c.kind,operationId:id??'preview',document:c.input.document,expectedBase:c.input.expectRevision};
   if(c.input.preview)return rack.publicationPreview(command);break;
  }
  case 'environment.apply':command={kind:c.kind,operationId:id,environmentId:c.input.target,revisionId:c.input.revision};break;
  case 'environment.prepare':if(c.input.preview)return rack.preparationPreview(c.input);command={kind:c.kind,operationId:id,input:c.input};break;
  case 'environment.inspect':return rack.inspect(c.input.target,c.input.revision);
  case 'environment.validate':command={kind:c.kind,operationId:id,input:c.input};break;
  case 'operation.continue':command={kind:c.kind,operationId:id,input:c.input};break;
  case 'operation.cancel':command={kind:c.kind,operationId:id,input:c.input};break;
  case 'environment.remove':command={kind:c.kind,operationId:id,environmentId:c.input.target,expectedBase:c.input.expectRevision};break;
  case 'mount.create':command={kind:c.kind,operationId:id,id:`m-${id}`,component:c.input.component};break;
  case 'mount.stop':command={kind:c.kind,operationId:id,id:c.input.target,force:c.input.force};break;
  case 'mount.replace':command={kind:c.kind,operationId:id,id:c.input.target,releaseId:c.input.release,force:c.input.force};break;
  case 'mount.observe':return rack.execute({kind:'observe',mountId:c.input.target,...c.input.uri?{uri:c.input.uri}:{}},actor);
  case 'binding.create':command={kind:c.kind,operationId:id,mountId:c.input.mount,principal:c.input.principal,access:c.input.access};break;
  case 'binding.release':command={kind:c.kind,operationId:id,id:c.input.target};break;
  case 'operation.get':return rack.operation(c.input.target.split(':').at(-1)!);
 }
 if(command){let connection:unknown;try{const result=await rack.execute(command,actor);if(command.kind==='binding.create')connection=result;}catch(error){if(error instanceof RackFault&&['ACTOR_DENIED','OPERATION_CONFLICT','CLEANUP_PENDING','STATE_CAPACITY','SHUTTING_DOWN'].includes(error.code))throw error;try{return rack.operation(id);}catch{throw error;}}const receipt=rack.operation(id);return connection?{...receipt,connection}:receipt;}
 if(c.kind==='environment.get'&&c.input.revision)return rack.revision(c.input.target,c.input.revision);
 const inventory=await rack.inventory();
 const find=<T extends {id:string}>(items:T[],id:string)=>{const value=items.find(v=>v.id===id);if(!value)throw new RackFault('NOT_FOUND','Requested retained entity does not exist',404);return value;};
 const page=<T>(items:T[],after:number,limit=rack.config.cliPageSize)=>{if(limit>rack.config.cliPageSize||after>items.length)throw new RackFault('INVALID_CURSOR','Read exceeds configured record bound',400);return {items:items.slice(after,after+limit),next:after+limit<items.length?after+limit:null};};
 switch(c.kind){
  case 'capability.list':return page(inventory.capabilities,c.input.after,c.input.limit);
  case 'environment.list':return page(inventory.environments.map(value=>({...value,applied:inventory.realizations.find(r=>r.id===inventory.activeRealizations[value.id])??null})),c.input.after,c.input.limit);
  case 'environment.get':return find(inventory.environments,c.input.target).head;
  case 'release.get':return {release:find(inventory.releases,c.input.target),provenance:await rack.provenance(c.input.target)};
  case 'mount.list':return page(inventory.mounts,c.input.after,c.input.limit);
  case 'mount.get':return find(inventory.mounts,c.input.target);
  case 'binding.list':return page(inventory.bindings,c.input.after,c.input.limit);
  case 'binding.get':return find(inventory.bindings,c.input.target);
  default:throw new RackFault('OPERATION_OWNER','Command is not owned by Environment',400);
 }
}
