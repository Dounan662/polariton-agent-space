import { mkdir, readFile, readdir, realpath, rm, stat, lstat } from 'node:fs/promises';
import { basename, join, relative, dirname, resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ContainerBackend, command as runCommand } from './backend.ts';
import { RackStore, durable, readJson, digest, json } from './storage.ts';
import { Command, EnvironmentHead, Revision, ReleaseRecord, Provenance, CapabilitySource, RackFault, type RackConfig, type Inventory, type ManagedCapability, type Release, type Mount, type Binding, type Connection, type Realization, type Observation, type Operation, type Component, type ManagedComponent, type ConnectionRevision, type Capability, PreviewInput, type ImportPreview } from './contracts.ts';
import {owner,type Actor} from '../caller.ts';
import {loadOfficialCatalog} from './catalog.ts';
import {type OfficialManifest,type OfficialProvision,type OfficialEntry} from './contracts.ts';
import { Connections } from './connections.ts';
import { AccessRequest, AccessRelease, type AccessRecord, type AccessGrant, type EnvironmentChoice } from './contracts.ts';

export type RackBackend = Pick<ContainerBackend,'ready'|'owned'|'remove'|'install'|'publishAuthority'|'start'|'inspect'>;

/** Owns configuration publication, release identity and runtime lifecycle. Callers never coordinate
 * database rows, containers, credentials or recovery. Observation never executes action tools.
 */
export class EnvironmentRack {
  private store!:RackStore;private backend!:RackBackend;private secret!:string;private owner!:string;
  private locks=new Map<string,Promise<unknown>>();private timer?:NodeJS.Timeout;private monitoring=false;
  private observations=new Set<Promise<unknown>>();
  private closing=false;private installing=0;private observing=0;private ajv=new Ajv({strict:true,allErrors:true});
  readonly config:RackConfig;
  private connections:Connections;private official!:OfficialManifest;private catalogFixture?:OfficialManifest;
  private backendFactory:(config:RackConfig,owner:string)=>RackBackend;
  constructor(config:RackConfig,backendFactory:(config:RackConfig,owner:string)=>RackBackend=(config,owner)=>new ContainerBackend(config,owner),catalogFixture?:OfficialManifest){this.catalogFixture=catalogFixture;this.config=config;this.backendFactory=backendFactory;this.connections=new Connections(config);}
  async open(){
    this.store=await RackStore.open(this.config.stateRoot,this.config.maxRecords);
    try{
      this.official=await loadOfficialCatalog(this.config,this.catalogFixture);
      for(const entry of this.official.entries){if(entry.definition.kind!=='managed')this.connections.validate(entry.definition);const retained=this.store.get<OfficialProvision>('official-provision',`${entry.id}/${entry.version}`);if(retained&&retained.entry.digest!==entry.digest)throw new RackFault('CATALOG_IMMUTABLE','A distributed entry version changed after provisioning');}
      this.owner=this.store.get<string>('identity','owner')??randomUUID();this.store.put('identity','owner',this.owner);
      this.secret=this.store.get<string>('identity','secret')??randomBytes(32).toString('hex');this.store.put('identity','secret',this.secret);
      this.backend=this.backendFactory(this.config,this.owner);
      await mkdir(join(this.config.stateRoot,'environments'),{recursive:true});
      // Revisions and their head are authoritative even if a crash preceded the receipt commit.
      for(const op of this.store.list<Operation>('operation').filter(o=>o.state==='running')){
        op.state='failed';op.error='Daemon interrupted the operation; inspect effects before retry';this.store.put('operation',op.id,op);
      }
      if(this.store.list<Mount>('mount').length){
        try{
          await this.managedReady();
          const containers=await this.backend.owned();
          for(const container of containers){
            const mount=this.store.get<Mount>('mount',container.labels['polariton.mount']??'');
            if(!mount||mount.generation!==container.labels['polariton.generation']||mount.component.releaseId!==container.labels['polariton.release']){await this.backend.remove(container.id);continue;}
            mount.containerId=container.id;mount.endpoint=container.endpoint;this.store.put('mount',mount.id,mount);
          }
          for(const mount of this.store.list<Mount>('mount')){
            if(mount.desired==='running')await this.withLock(`mount:${mount.id}`,()=>this.ensureRunning(mount));
            else if(mount.state==='draining'||mount.pendingReleaseId)await this.stopMount(mount,false);
            else if(mount.containerId){await this.backend.remove(mount.containerId);mount.containerId=null;mount.endpoint=null;this.store.put('mount',mount.id,mount);}
          }
        }catch(error){
          for(const mount of this.store.list<Mount>('mount')){mount.state='failed';mount.error=error instanceof RackFault?`${error.code}: ${error.message}`:'Managed container backend is unavailable';this.store.put('mount',mount.id,mount);}
          console.error(json({event:'environment.backend.unavailable',code:error instanceof RackFault?error.code:'BACKEND_UNAVAILABLE'}));
        }
      }
      for(const access of this.store.list<AccessRecord>('access'))if(access.state==='acquiring'||access.state==='releasing'){
        try{await this.releaseAccess({id:access.id,owner:access.owner});}catch{console.error(json({event:'environment.access.cleanup.pending',accessId:access.id}));}
      }
      this.timer=setInterval(()=>void this.monitor(),this.config.monitorMs);this.timer.unref();return this;
    }catch(error){this.store.close();throw error;}
  }
  private withLock<T>(key:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.locks.get(key)??Promise.resolve();const pending=previous.catch(()=>{}).then(work);
    this.locks.set(key,pending);void pending.finally(()=>{if(this.locks.get(key)===pending)this.locks.delete(key);}).catch(()=>{});return pending;
  }
  private required<T>(kind:string,id:string):T{const value=this.store.get<T>(kind,id);if(!value)throw new RackFault('NOT_FOUND',`${kind} ${id} does not exist`,404);return value;}
  private release(id:string){return this.required<Release>('release',id);}
  private async pointer(id:string):Promise<EnvironmentHead|null>{try{return EnvironmentHead.parse(await readJson(join(this.config.stateRoot,'environments',id,'head.json')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
  private async head(id:string):Promise<Revision|null>{const pointer=await this.pointer(id);return pointer&&!pointer.removed?this.revision(id,pointer.revisionId):null;}
  async revision(environmentId:string,revisionId:string){return Revision.parse(await readJson(join(this.config.stateRoot,'environments',environmentId,'revisions',`${revisionId}.json`)));}
  async provenance(releaseId:string):Promise<Provenance>{this.release(releaseId);return Provenance.parse(await readJson(join(this.config.stateRoot,'releases',releaseId,'provenance.json')));}
  private async managedReady(options:{start?:boolean}={}){
    try{await this.backend.ready(options);}
    catch(error){const fault=error instanceof RackFault?error:new RackFault('BACKEND_UNAVAILABLE','Managed container backend is unavailable');console.error(json({event:'environment.runtime.unavailable',code:fault.code,error:fault.message}));throw fault;}
  }
  /** Inspect exact catalog revisions without preparing or launching anything. */
  capability(id:string,revisionId?:string):Capability{
    if(revisionId)return this.required<ConnectionRevision>('capability-revision',`${id}/${revisionId}`);
    return this.required<Capability>('capability',id);
  }
  async preview(raw:unknown):Promise<ImportPreview>{
    const input=PreviewInput.parse(raw),preview=await this.connections.preview(input);
    for(const entry of preview.entries){if(this.store.list<Capability>('capability').some(capability=>capability.id!==input.capabilityId&&capability.name===entry.name))preview.errors.push({name:entry.name,code:'CAPABILITY_EXISTS',message:'Capability name already exists; use an explicit definition revision update'});}
    return preview;
  }
  private definition(component:Exclude<Component,ManagedComponent>):ConnectionRevision{
    const definition=this.capability(component.definition.capabilityId,component.definition.revisionId);
    if(definition.kind==='managed')throw new RackFault('DEFINITION_KIND','Select a connection definition');return definition;
  }
  private serverName(id:string){return /^[A-Za-z0-9_-]{1,32}$/.test(id)?id:`c_${digest(id).slice(0,30)}`;}
  /** Applied heads remain selectable when individual capabilities become unavailable.
   * Discovery belongs to DSH; listing choices never probes endpoints or starts programs. */
  async choices():Promise<EnvironmentChoice[]>{
    const choices:EnvironmentChoice[]=[];
    for(const id of await readdir(join(this.config.stateRoot,'environments'))){
      const revision=await this.head(id);if(!revision)continue;
      const realization=this.preparation(revision);
      if(realization)choices.push({environment:{environmentId:id,revisionId:revision.revisionId,name:revision.name},observedAt:realization.createdAt});
    }
    return choices;
  }
  private preparation(revision:Revision){return this.store.list<Realization>('realization').filter(value=>value.environmentId===revision.environmentId&&value.revisionId===revision.revisionId&&value.status!=='applying').at(-1);}
  private runtimePath(accessId:string,componentId:string){return join(this.config.stateRoot,'runtime',accessId,digest(componentId));}
  private async resolveAccess(revision:Revision,access:AccessRequest):Promise<Array<{component:Component;mountId:string|null;server?:AccessGrant['servers'][number];runtime?:boolean;code:AccessGrant['components'][number]['code']}>>{
    const realization=this.preparation(revision);
    if(!realization)throw new RackFault('ENVIRONMENT_UNAVAILABLE','Apply the selected environment revision before assigning it');
    const names=revision.components.map(component=>this.serverName(component.id));
    if(new Set(names).size!==names.length)throw new RackFault('SERVER_NAME','Component names collide in DSH');
    const resolved:Awaited<ReturnType<EnvironmentRack['resolveAccess']>>=[];
    for(const component of revision.components){
      const entry=realization.components.find(value=>value.componentId===component.id);
      if(!entry||entry.error||entry.readiness==='unavailable'){resolved.push({component,mountId:null,code:'PREPARATION_UNAVAILABLE'});continue;}
      if('releaseId' in component){
        const mount=entry.mountId?this.store.get<Mount>('mount',entry.mountId):undefined;
        if(mount)this.assertCompatible(mount,component);
        resolved.push({component,mountId:mount?.id??null,code:!mount||mount.state!=='running'||mount.desired!=='running'||mount.pendingReleaseId||!mount.endpoint?'MOUNT_UNAVAILABLE':null});
      }else{
        // Invalid catalog references are identity errors, not endpoint availability.
        const definition=this.definition(component);
        const runtime=definition.kind==='stdio'&&[...definition.args,...Object.values(definition.env)].some(value=>value.includes('${POLARITON_RUNTIME}'));
        try{resolved.push({component,mountId:null,runtime,code:null,server:await this.connections.resolve(definition,this.serverName(component.id),{workspace:access.workspace,runtime:this.runtimePath(access.id,component.id)})});}
        catch{resolved.push({component,mountId:null,code:'CONNECTION_UNAVAILABLE'});}
      }
    }
    return resolved;
  }
  /** Availability failures disable only their component. Identity and unconfirmed cleanup
   * failures remain fatal; an issued access retains its ownership until Main settles DSH. */
  async acquireAccess(raw:AccessRequest):Promise<AccessGrant>{
    const input=AccessRequest.parse(raw);
    if(this.closing)throw new RackFault('SHUTTING_DOWN','EnvironmentDaemon is shutting down');
    return this.withLock(`access:${input.id}`,async()=>{
      let access=this.store.get<AccessRecord>('access',input.id);
      if(access&&(access.owner!==input.owner||access.request&&json(access.request)!==json(input)))throw new RackFault('ACCESS_CONFLICT','Access identity belongs to another request');
      if(access&&(access.state==='released'||access.state==='releasing'))throw new RackFault('ACCESS_RELEASED','Access was released; use a new activation identity');
      const issued=access?.state==='active';
      const revision=await this.revision(input.environment.environmentId,input.environment.revisionId);
      try{if(!(await stat(input.workspace)).isDirectory())throw new Error();}catch{throw new RackFault('WORKSPACE_UNAVAILABLE','Worker workspace is unavailable');}
      if(input.requireHead&&!access){const head=await this.head(revision.environmentId);if(head?.revisionId!==revision.revisionId)throw new RackFault('STALE_REVISION','The selected environment changed; select its applied head again');}
      const resolved=await this.resolveAccess(revision,input);
      if(!access){access={id:input.id,owner:input.owner,request:input,state:'acquiring',bindings:[],runtimeComponents:[],resources:[],error:null};this.store.put('access',access.id,access);}
      const owned=access,servers:AccessGrant['servers']=[],components:AccessGrant['components']=[];
      try{
        for(const item of resolved){
          const status:AccessGrant['components'][number]={componentId:item.component.id,serverName:this.serverName(item.component.id),status:'unavailable',code:item.code};components.push(status);
          if(item.code)continue;
          const resource=item.component.resource;
          const conflicts=[...this.store.list<AccessRecord>('access').filter(value=>value.id!==owned.id&&value.state!=='released').flatMap(value=>value.resources),...this.store.list<Mount>('mount').filter(mount=>(mount.containerId!==null||mount.desired==='running'||mount.state==='draining')&&mount.id!==item.mountId).flatMap(mount=>mount.component.resource?[mount.component.resource]:[])];
          if(resource&&conflicts.some(other=>resource.identity===other.identity&&(resource.exclusive||other.exclusive))){status.code='RESOURCE_BUSY';continue;}
          const previousResources=[...owned.resources],existingBinding=owned.bindings.find(value=>value.componentId===item.component.id),existingRuntime=owned.runtimeComponents.includes(item.component.id);
          // Journal reservations and cleanup intent before touching external authority or scratch.
          if(resource){const index=owned.resources.findIndex(value=>value.identity===resource.identity);if(index<0)owned.resources.push(resource);else if(resource.exclusive)owned.resources[index]={...owned.resources[index]!,exclusive:true};}
          if(item.runtime&&!existingRuntime)owned.runtimeComponents.push(item.component.id);
          const binding=item.mountId?(existingBinding??{mountId:item.mountId,componentId:item.component.id,id:`a-${randomUUID()}`}):undefined;
          if(binding&&!existingBinding)owned.bindings.push(binding);
          this.store.put('access',owned.id,owned);
          let stage:AccessGrant['components'][number]['code']='RUNTIME_UNAVAILABLE';
          try{
            if(item.runtime)await mkdir(this.runtimePath(owned.id,item.component.id),{recursive:true,mode:0o700});
            stage='GRANT_UNAVAILABLE';
            if(binding){
              const connection=await this.withLock(`mount:${binding.mountId}`,async()=>{
                if(!('releaseId' in item.component))throw new RackFault('DEFINITION_KIND','Managed component required');
                const mount=this.required<Mount>('mount',binding.mountId);this.assertCompatible(mount,item.component);
                if(mount.desired!=='running'||mount.pendingReleaseId)throw new RackFault('MOUNT_UNAVAILABLE','Required mount is draining');
                return this.bind(binding.mountId,binding.id,input.principal,'call',owned.id);
              });
              servers.push({type:'http',name:status.serverName,url:connection.url,headers:connection.headers});
            }else servers.push(item.server!);
            status.status='ready';status.code=null;
          }catch(error){
            if(error instanceof RackFault&&['BINDING_CONFLICT','MOUNT_INCOMPATIBLE','DEFINITION_KIND','ACCESS_OWNER'].includes(error.code))throw error;
            status.code=stage;
            // Never revoke a grant or delete scratch that an earlier reply could have issued.
            // New failed acquisitions must settle before returning a degraded connection list.
            try{
              if(binding&&!existingBinding){await this.releaseBinding(owned,binding);owned.bindings=owned.bindings.filter(value=>value.id!==binding.id);}
              if(item.runtime&&!existingRuntime){await rm(this.runtimePath(owned.id,item.component.id),{recursive:true,force:true});owned.runtimeComponents=owned.runtimeComponents.filter(value=>value!==item.component.id);}
              owned.resources=previousResources;this.store.put('access',owned.id,owned);
            }catch{throw new RackFault('ACCESS_CLEANUP_PENDING','A failed component has an unconfirmed cleanup obligation');}
          }
        }
        const grant={id:owned.id,servers,components};
        if(Buffer.byteLength(json(grant))>this.config.maxBodyBytes)throw new RackFault('ACCESS_SIZE','Resolved connection list exceeds the configured byte budget');
        owned.state='active';owned.error=null;this.store.put('access',owned.id,owned);return grant;
      }catch(error){
        owned.error='Environment access cleanup requires attention';
        if(issued){this.store.put('access',owned.id,owned);throw new RackFault('ACCESS_CLEANUP_PENDING','Settle the worker before releasing its existing access');}
        try{await this.revokeAccess(owned);}catch{throw new RackFault('ACCESS_CLEANUP_PENDING','Access setup failed and grant cleanup requires retry');}
        throw error;
      }
    });
  }
  private async releaseBinding(access:AccessRecord,entry:AccessRecord['bindings'][number]){
    await this.withLock(`mount:${entry.mountId}`,async()=>{
      const binding=this.store.get<Binding>('binding',entry.id);if(!binding)return;
      if(binding.accessId!==access.id||binding.mountId!==entry.mountId||binding.principal!==access.request?.principal)throw new RackFault('ACCESS_OWNER','Binding belongs to another access');
      binding.released=true;this.store.put('binding',binding.id,binding);
      const mount=this.required<Mount>('mount',entry.mountId);await this.writeAuthority(mount);
      if((mount.state==='draining'||mount.pendingReleaseId)&&!this.activeBindings(mount).length)await this.stopMount(mount,false);
    });
  }
  /** A tombstone also cancels delayed acquisition. Releasing access never requests a mount stop. */
  async releaseAccess(raw:{id:string;owner:string}):Promise<void>{
    const input=AccessRelease.parse(raw);
    return this.withLock(`access:${input.id}`,async()=>{
      const access=this.store.get<AccessRecord>('access',input.id);
      if(access&&access.owner!==input.owner)throw new RackFault('ACCESS_OWNER','Access belongs to another owner',403);
      if(!access){this.store.put('access',input.id,{...input,request:null,state:'released',bindings:[],runtimeComponents:[],resources:[],error:null});return;}
      if(access.state!=='released')await this.revokeAccess(access);
    });
  }
  private async revokeAccess(access:AccessRecord){
    access.state='releasing';this.store.put('access',access.id,access);
    let failed=false;
    for(const entry of access.bindings){try{await this.releaseBinding(access,entry);}catch{failed=true;}}
    if(access.runtimeComponents.length){try{await rm(join(this.config.stateRoot,'runtime',access.id),{recursive:true,force:true});}catch{failed=true;}}
    access.error=failed?'Grant or runtime cleanup did not settle; retry release':null;access.state=failed?'releasing':'released';this.store.put('access',access.id,access);
    if(failed){console.error(json({event:'environment.access.cleanup.pending',accessId:access.id}));throw new RackFault('ACCESS_CLEANUP_PENDING',access.error!);}
  }
  /** Inspection joins distributed availability with retained provisioning, without preparation or runtime probes. */
  catalog(after=0,limit=this.config.cliPageSize){
    const entries=new Map<string,OfficialEntry>(this.official.entries.map(entry=>[`${entry.id}/${entry.version}`,entry]));
    for(const saved of this.store.list<OfficialProvision>('official-provision'))if(!entries.has(`${saved.entry.id}/${saved.entry.version}`))entries.set(`${saved.entry.id}/${saved.entry.version}`,saved.entry);
    const items=[...entries.values()].sort((a,b)=>`${a.id}/${a.version}`.localeCompare(`${b.id}/${b.version}`)).map(entry=>{
      const saved=this.store.get<OfficialProvision>('official-provision',`${entry.id}/${entry.version}`);
      const origin=saved?.origin??{kind:'official' as const,catalogVersion:this.official.version,entryId:entry.id,version:entry.version,digest:entry.digest};
      const release=saved?.releaseId?this.store.get<Release>('release',saved.releaseId):undefined;
      const installed=!!release&&release.packageId===saved?.capabilityId&&release.origin?.digest===entry.digest;
      return {entry,origin,available:this.official.entries.some(value=>value.id===entry.id&&value.version===entry.version),capabilityId:saved?.capabilityId??null,releaseId:installed?saved!.releaseId:null,state:installed?'installed' as const:saved?.capabilityId?'registered' as const:'unprovisioned' as const};
    });
    if(limit>this.config.cliPageSize||after>items.length)throw new RackFault('INVALID_CURSOR','Read exceeds configured record bound',400);
    return {catalogVersion:this.official.version,items:items.slice(after,after+limit),next:after+limit<items.length?after+limit:null};
  }
  catalogEntry(id:string){
    const versions=[];let after=0;
    do{const page=this.catalog(after);versions.push(...page.items.filter(value=>value.entry.id===id));if(page.next===null)break;after=page.next;}while(true);
    if(!versions.length)throw new RackFault('NOT_FOUND','Official entry does not exist',404);
    return {catalogVersion:this.official.version,id,versions};
  }
  async inventory():Promise<Inventory>{
    const environments=[];for(const id of await readdir(join(this.config.stateRoot,'environments'))){const head=await this.head(id);if(head)environments.push({id,head});}
    return {capabilities:this.store.list('capability'),releases:this.store.list('release'),environments,mounts:this.store.list('mount'),realizations:this.store.list('realization'),activeRealizations:Object.fromEntries(environments.map(value=>[value.id,this.store.get<string>('active-realization',value.id)??''])),operations:this.store.list<Operation>('operation').map(op=>({...op,result:op.command.kind==='binding.create'?null:op.result})),observations:this.store.list<Observation>('observation').map(value=>({...value,stale:!value.available||Date.now()-Date.parse(value.observedAt)>this.config.observationFreshMs})),bindings:this.store.list<Binding>('binding').map(({hash,accessId,...binding})=>binding)};
  }
  /** Public receipts omit connection secrets and retain failed recovery attempts. */
  operation(id:string){const op=this.required<Operation>('operation',id);return {reference:`environment:${id}`,requestId:id,actor:op.actor,command:op.command.kind,input:op.command,state:op.state==='waiting'&&op.command.kind==='environment.apply'?'partial':op.state,result:op.result,error:op.error?{code:op.errorCode??'ENVIRONMENT_FAILED',message:op.error}:null,attempts:op.attempts.map(attempt=>({at:Date.parse(attempt.at),state:attempt.state,...attempt.error?{code:attempt.errorCode??'ENVIRONMENT_FAILED'}:{}}))};}
  async publicationPreview(input:Extract<Command,{kind:'environment.publish'}>){
    const {document:doc,expectedBase}=input,pointer=await this.pointer(doc.environmentId),base=pointer?await this.revision(doc.environmentId,pointer.revisionId):null;
    if(pointer?.removed)throw new RackFault('ENVIRONMENT_REMOVED','Environment was removed');
    if((base?.revisionId??null)!==expectedBase)throw new RackFault('STALE_REVISION','Environment changed; reload before publishing');
    if(new Set(doc.components.map(value=>value.id)).size!==doc.components.length)throw new RackFault('COMPONENT_ID','Component IDs must be unique');
    for(const component of doc.components)this.validateComponent(component);
    return {valid:true,base,document:doc,changed:base?json({...base,revisionId:undefined,baseRevisionId:undefined,createdAt:undefined,operationId:undefined})!==json(doc):true,reserved:false};
  }
  async execute(input:unknown,actor:Actor=owner):Promise<unknown>{
    const command=Command.parse(input);if(command.kind==='catalog.provision'&&actor.kind!=='owner')throw new RackFault('ACTOR_DENIED','Official provisioning requires the administrative owner',403);if(command.kind==='capability.import')for(const entry of command.entries)this.connections.validate(entry.definition);if(command.kind==='capability.revise')this.connections.validate(command.entry.definition);if(this.closing)throw new RackFault('SHUTTING_DOWN','EnvironmentDaemon is shutting down');
    if(command.kind==='observe')return this.observe(command.mountId,command.uri);
    const key=command.kind==='environment.publish'?`environment:${command.document.environmentId}`:
      (command.kind==='environment.apply'||command.kind==='environment.remove')?`environment:${command.environmentId}`:
      command.kind==='release.install'?`package:${command.packageId}`:
      command.kind==='binding.create'?`mount:${command.mountId}`:
      command.kind==='binding.release'?`mount:${this.required<Binding>('binding',command.id).mountId}`:
      ['capability.register','capability.import','capability.revise','catalog.provision'].includes(command.kind)?'catalog':`mount:${'id' in command?command.id:''}`;
    return this.withLock(`operation:${command.operationId}`,()=>this.withLock(key,async()=>{
      const prior=this.store.get<Operation>('operation',command.operationId);
      if(prior&&(json(prior.command)!==json(command)||prior.actor.kind!==actor.kind||prior.actor.id!==actor.id))throw new RackFault('OPERATION_CONFLICT','Operation ID was already used for different input');
      if(prior?.state==='succeeded')return command.kind==='binding.create'?this.connection(command.operationId):prior.result;
      // Cleanup consumes an existing obligation. Its bounded reserve cannot be filled by
      // repeated failed attempts with fresh IDs; the original receipt must be retried.
      let recovery=false;
      if(command.kind==='binding.release'||command.kind==='mount.stop'){
        const pendingOperations=this.store.list<Operation>('operation').filter(value=>value.id!==command.operationId&&value.state!=='succeeded'&&value.command.kind===command.kind&&'id' in value.command&&value.command.id===command.id);
        const pending=pendingOperations.find(value=>value.command.kind==='mount.stop'&&value.command.force)??pendingOperations[0];
        const escalation=command.kind==='mount.stop'&&command.force&&pending?.command.kind==='mount.stop'&&!pending.command.force;
        if(pending&&!escalation)throw new RackFault('CLEANUP_PENDING',`Retry cleanup operation ${pending.id}`);
        const target=command.kind==='binding.release'?this.required<Binding>('binding',command.id):this.required<Mount>('mount',command.id);
        recovery='released' in target?!target.released:(!target.pendingReleaseId||command.kind==='mount.stop'&&command.force)&&(target.containerId!==null||target.desired==='running'||target.state==='draining');

      }
      if((prior?.attempts.length??0)>=this.config.maxRecords)throw new RackFault('STATE_CAPACITY','Operation attempt retention is full');
      const op:Operation={actor,attempts:[...(prior?.attempts??[]),{at:new Date().toISOString(),state:'running',error:null}],id:command.operationId,command,state:'running',result:null,error:null};this.store.put('operation',op.id,op,recovery);
      try{const result=await this.apply(command);if((command.kind==='mount.create'||command.kind==='mount.replace')&&(result as Mount).state==='failed')throw new RackFault('MOUNT_FAILED',(result as Mount).error??'Mount startup failed');const waiting=(command.kind==='environment.apply'&&(result as Realization).status!=='ready')||((command.kind==='mount.stop'||command.kind==='mount.replace')&&(result as Mount).state==='draining');op.state=waiting?'waiting':'succeeded';op.result=command.kind==='binding.create'?{bindingId:command.operationId}:result;op.attempts[op.attempts.length-1]={at:new Date().toISOString(),state:op.state,error:null};this.store.put('operation',op.id,op);return result;}
      catch(error){op.state='failed';op.error=error instanceof RackFault?error.message:'Environment operation failed';op.errorCode=error instanceof RackFault?error.code:'ENVIRONMENT_FAILED';op.attempts[op.attempts.length-1]={at:new Date().toISOString(),state:op.state,error:op.error,errorCode:op.errorCode};this.store.put('operation',op.id,op);console.error(json({event:'environment.operation.failed',operationId:op.id,kind:command.kind,code:op.errorCode,error:op.error}));throw error;}
    }));
  }
  private async apply(command:Exclude<Command,{kind:'observe'}>):Promise<unknown>{
    switch(command.kind){
      case 'catalog.provision':{
        const key=`${command.entryId}/${command.version}`;
        let saved=this.store.get<OfficialProvision>('official-provision',key);
        const entry=saved?.entry??this.official.entries.find(value=>value.id===command.entryId&&value.version===command.version);
        if(!entry)throw new RackFault('NOT_FOUND','Exact official entry version is unavailable',404);
        if(command.install&&entry.definition.kind!=='managed')throw new RackFault('CATALOG_INSTALL','Only managed entries support --install; prepare connections through Environment Apply',400);
        if(!saved){
          saved={entry,origin:{kind:'official',catalogVersion:this.official.version,entryId:entry.id,version:entry.version,digest:entry.digest},capabilityId:null,releaseId:entry.definition.kind==='managed'?`or-${digest(key).slice(0,40)}`:null};
          this.store.put('official-provision',key,saved);
        }
        if(!saved.capabilityId){
          const origin=saved.origin;
          const id=`o-${digest(key).slice(0,40)}`,name=`${entry.name} (${entry.id}@${entry.version})`,createdAt=new Date().toISOString();
          let capability:Capability;
          if(entry.definition.kind==='managed'){
            const configured=this.config.catalogSources[entry.definition.source];
            if(!configured)throw new RackFault('CATALOG_SOURCE','Configure the named local Git source before provisioning',400);
            const source=await this.source(join(configured,entry.definition.subdirectory));
            if(source.repository!==await realpath(configured)||source.subdirectory!==entry.definition.subdirectory)throw new RackFault('CATALOG_SOURCE','Configured source must identify the owning Git root',400);
            await runCommand('git',['-C',source.repository,'cat-file','-e',`${entry.definition.commit}^{commit}`],this.config.operationTimeoutMs,this.config.maxBodyBytes);
            capability={kind:'managed',id,name,source,origin,createdAt};
          }else{
            this.connections.validate(entry.definition);
            capability={...entry.definition,id,name,origin,revisionId:id,baseRevisionId:null,operationId:command.operationId,createdAt};
          }
          if(this.store.get('capability',id)||this.store.list<Capability>('capability').some(value=>value.name===name))throw new RackFault('CAPABILITY_EXISTS','Official provisioning would overwrite an existing capability');
          this.admitCapabilities(1);
          saved={entry,origin,capabilityId:id,releaseId:entry.definition.kind==='managed'?`or-${digest(key).slice(0,40)}`:null};
          this.store.transaction(()=>{this.store.put('capability',id,capability);if(capability.kind!=='managed')this.store.put('capability-revision',`${id}/${id}`,capability);this.store.put('official-provision',key,saved);});
        }
        if(command.install&&entry.definition.kind==='managed'){const install={kind:'release.install' as const,operationId:saved.releaseId!,packageId:saved.capabilityId!,commit:entry.definition.commit};await this.withLock(`package:${saved.capabilityId}`,()=>this.apply(install));}
        return this.catalogEntry(entry.id).versions.find(value=>value.entry.version===entry.version)!;
      }
      case 'capability.register':{
        // A workspace package and a standalone repository use the same source identity.
        // Registration observes the path only; installation chooses an exact committed tree.
        const source=await this.source(command.repository),directory=join(source.repository,source.subdirectory);
        const registered=this.store.list<ManagedCapability>('capability').filter(value=>value.kind==='managed'&&!value.origin).find(value=>json(value.source)===json(source));
        const id=command.id??registered?.id??`p-${digest(json(source)).slice(0,32)}`;
        const existing=this.store.get<Capability>('capability',id);
        if(existing&&(existing.kind!=='managed'||json(existing.source)!==json(source)))throw new RackFault('PACKAGE_EXISTS','Package already identifies a different source directory');
        const value=existing??{kind:'managed' as const,id,name:basename(directory),source,createdAt:new Date().toISOString()};if(this.store.list<Capability>('capability').some(other=>other.id!==id&&other.name===value.name))throw new RackFault('CAPABILITY_EXISTS','Capability name already exists');this.admitCapabilities(existing?0:1);this.store.put('capability',value.id,value);return value;
      }
      case 'capability.import':{
        if(command.entries.length>this.config.maxImportEntries)throw new RackFault('IMPORT_LIMIT','Import entry count exceeds the configured limit');
        const names=command.entries.map(entry=>entry.name);
        if(new Set(names).size!==names.length)throw new RackFault('CAPABILITY_EXISTS','Import names must be unique');
        const capabilities=command.entries.map(entry=>{
          const id=`c-${digest(`${command.operationId}:${entry.name}`).slice(0,32)}`,revisionId=`r-${digest(`${command.operationId}:${entry.name}`).slice(0,32)}`;
          const saved=this.store.get<ConnectionRevision>('capability-revision',`${id}/${revisionId}`);
          if(saved){if(saved.name!==entry.name||json(this.definitionValue(saved))!==json(entry.definition))throw new RackFault('OPERATION_CONFLICT','Retained import differs from the operation');return saved;}
          if(this.store.list<Capability>('capability').some(value=>value.name===entry.name))throw new RackFault('CAPABILITY_EXISTS','Capability name already exists; publish a deliberate revision');
          return {...entry.definition,id,name:entry.name,revisionId,baseRevisionId:null,operationId:command.operationId,createdAt:new Date().toISOString()};
        });
        this.admitCapabilities(capabilities.filter(value=>!this.store.get('capability',value.id)).length);
        this.store.transaction(()=>{for(const value of capabilities){if(!this.store.get('capability-revision',`${value.id}/${value.revisionId}`)){this.store.put('capability-revision',`${value.id}/${value.revisionId}`,value);this.store.put('capability',value.id,value);}}});
        return {capabilities};
      }
      case 'capability.revise':{
        const saved=this.store.get<ConnectionRevision>('capability-revision',`${command.id}/${command.operationId}`);if(saved)return saved;
        const current=this.capability(command.id);
        if(current.origin)throw new RackFault('CATALOG_IMMUTABLE','Official definitions are immutable; import a separate customized capability');
        if(current.kind==='managed')throw new RackFault('CAPABILITY_KIND','Managed capabilities evolve through installed releases');
        if(current.revisionId!==command.expectedBase)throw new RackFault('STALE_REVISION','Capability definition changed; inspect its current revision');
        if(command.entry.definition.kind!==current.kind)throw new RackFault('CAPABILITY_KIND','Changing transport requires a new capability');
        if(this.store.list<Capability>('capability').some(value=>value.id!==command.id&&value.name===command.entry.name))throw new RackFault('CAPABILITY_EXISTS','Capability name already exists');
        if(this.store.list<ConnectionRevision>('capability-revision').filter(value=>value.id===command.id).length>=this.config.maxRevisions)throw new RackFault('REVISION_CAPACITY','Retained capability revision capacity reached');
        const value={...command.entry.definition,id:command.id,name:command.entry.name,revisionId:command.operationId,baseRevisionId:command.expectedBase,operationId:command.operationId,createdAt:new Date().toISOString()};
        this.store.transaction(()=>{this.store.put('capability-revision',`${value.id}/${value.revisionId}`,value);this.store.put('capability',value.id,value);});return value;
      }
      case 'release.install':{
        const id=command.operationId,existing=this.store.get<Release>('release',id);if(existing){if(existing.packageId!==command.packageId||existing.commit!==command.commit)throw new RackFault('RELEASE_CONFLICT','Retained release belongs to a different installation');return existing;}
        try{const saved=ReleaseRecord.parse(await readJson(join(this.config.stateRoot,'releases',id,'release.json')));if(saved.commit!==command.commit||saved.packageId!==command.packageId)throw new RackFault('RELEASE_CONFLICT','Retained release does not match installation');this.store.put('release',id,saved);return saved;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        await rm(join(this.config.stateRoot,'releases',id),{recursive:true,force:true});
        if(this.installing>=this.config.maxInstalls)throw new RackFault('INSTALL_CAPACITY','Installation capacity reached');
        if(this.store.list('release').length+this.installing>=this.config.maxReleases)throw new RackFault('RELEASE_CAPACITY','Retained release capacity reached');
        const pkg=this.required<Capability>('capability',command.packageId);if(pkg.origin){const entry=this.required<OfficialProvision>('official-provision',`${pkg.origin.entryId}/${pkg.origin.version}`).entry;if(entry.definition.kind!=='managed'||entry.definition.commit!==command.commit)throw new RackFault('CATALOG_IMMUTABLE','Official releases must use the catalog version’s exact commit');}if(pkg.kind!=='managed')throw new RackFault('CAPABILITY_KIND','Only managed repositories have releases');this.installing++;
        try{await this.managedReady({start:true});const result=await this.backend.install(pkg.source,command.commit,id);this.ajv.compile(result.manifest.configSchema);
          const release:Release={...result,...(pkg.origin?{origin:pkg.origin}:{}),id,packageId:pkg.id,createdAt:new Date().toISOString()};
          await durable(join(this.config.stateRoot,'releases',id,'release.json'),release);this.store.put('release',id,release);return release;
        }finally{this.installing--;}
      }
      case 'environment.publish':{
        const doc=command.document,pointer=await this.pointer(doc.environmentId);
        const head=pointer?await this.revision(doc.environmentId,pointer.revisionId):null;
        // A committed publication remains recoverable after newer heads or removal.
        // Recovery returns its receipt without clearing the current removal tombstone.
        for(let committed=head;committed;committed=committed.baseRevisionId?await this.revision(doc.environmentId,committed.baseRevisionId):null){if(committed.operationId===command.operationId){
          const {revisionId,baseRevisionId,createdAt,operationId,...document}=committed;
          if(baseRevisionId!==command.expectedBase||json(document)!==json(doc))throw new RackFault('OPERATION_CONFLICT','Operation ID was already used for different input');
          return committed;
        }}
        if(pointer?.removed)throw new RackFault('ENVIRONMENT_REMOVED','Environment has been removed');
        let retainedRevision=false;try{await readFile(join(this.config.stateRoot,'environments',doc.environmentId,'revisions',`${command.operationId}.json`));retainedRevision=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(!head&&!retainedRevision&&(await readdir(join(this.config.stateRoot,'environments'))).length>=this.config.maxEnvironments)throw new RackFault('ENVIRONMENT_CAPACITY','Environment capacity reached');
        if(head&&!retainedRevision&&(await readdir(join(this.config.stateRoot,'environments',doc.environmentId,'revisions'))).length>=this.config.maxRevisions)throw new RackFault('REVISION_CAPACITY','Retained revision capacity reached');
        if((head?.revisionId??null)!==command.expectedBase)throw new RackFault('STALE_REVISION','Environment changed; reload the current revision before publishing');
        if(new Set(doc.components.map(value=>value.id)).size!==doc.components.length)throw new RackFault('COMPONENT_ID','Component IDs must be unique');
        for(const component of doc.components)this.validateComponent(component);
        const revision:Revision={...doc,revisionId:command.operationId,baseRevisionId:command.expectedBase,createdAt:new Date().toISOString(),operationId:command.operationId};
        const path=join(this.config.stateRoot,'environments',doc.environmentId,'revisions',`${revision.revisionId}.json`);
        try{const saved=Revision.parse(await readJson(path));if(json({...saved,createdAt:revision.createdAt})!==json(revision))throw new RackFault('REVISION_CONFLICT','Revision identity already exists');revision.createdAt=saved.createdAt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await durable(path,revision);}
        await durable(join(this.config.stateRoot,'environments',doc.environmentId,'head.json'),{revisionId:revision.revisionId});return revision;
      }
      case 'environment.remove':{
        const pointer=await this.pointer(command.environmentId);
        if(!pointer)throw new RackFault('NOT_FOUND','Environment does not exist',404);
        // The head tombstone is the durable commit. Retry after a receipt-write crash
        // returns the original removal, and retained revisions remain readable.
        if(pointer.removed)return {environmentId:command.environmentId,...pointer.removed};
        if(pointer.revisionId!==command.expectedBase)throw new RackFault('STALE_REVISION','Environment changed; reload before removing');
        const removed={operationId:command.operationId,removedAt:new Date().toISOString()};
        await durable(join(this.config.stateRoot,'environments',command.environmentId,'head.json'),{...pointer,removed});
        return {environmentId:command.environmentId,...removed};
      }
      case 'environment.apply':{
        if((await this.pointer(command.environmentId))?.removed)throw new RackFault('ENVIRONMENT_REMOVED','Environment has been removed');
        const revision=await this.revision(command.environmentId,command.revisionId);
        const realization:Realization=this.store.get('realization',command.operationId)??{id:command.operationId,environmentId:revision.environmentId,revisionId:revision.revisionId,status:'applying',components:[],createdAt:new Date().toISOString()};
        realization.status='applying';this.store.put('realization',realization.id,realization);
        // One Apply owns one preparation attempt, including failure. Each component
        // reports that result without repeating a failed or uncertain VM start.
        let runtime:Promise<void>|undefined;
        for(const component of revision.components){
          if(!('releaseId' in component)){
            let error:string|null=null,errorCode:string|undefined;let readiness:Realization['components'][number]['readiness']='unavailable';
            let installation:Realization['components'][number]['installation'];
            try{const definition=this.definition(component);installation=await this.connections.prepare(definition);readiness=definition.kind==='http'?'ready-to-connect':'ready-to-launch';}
            catch(failure){error=failure instanceof RackFault?failure.message:'Connection preparation failed';errorCode=failure instanceof RackFault?failure.code:'CONNECTION_UNAVAILABLE';}
            realization.components=realization.components.filter(value=>value.componentId!==component.id);
            realization.components.push({componentId:component.id,mountId:null,error,...errorCode?{errorCode}:{},readiness,resource:component.resource?.identity??null,...(installation?{installation}:{})});this.store.put('realization',realization.id,realization);continue;
          }
          const previous=realization.components.find(value=>value.componentId===component.id)?.mountId;
          const defaultId=`m-${digest(`${revision.environmentId}:${component.id}:${json(component)}`).slice(0,32)}`;
          const retained=this.store.get<Mount>('mount',previous??defaultId);
          const changed=retained&&(retained.component.releaseId!==component.releaseId||json(retained.component.configuration)!==json(component.configuration));
          const mountId=component.sharedMountId??(changed?`m-${digest(`${command.operationId}:${component.id}`).slice(0,32)}`:previous??defaultId);
          let error:string|null=null,errorCode:string|undefined;
          try{await (runtime??=this.managedReady({start:true}));await this.withLock(`mount:${mountId}`,async()=>{
            this.validateComponent(component);const existing=this.store.get<Mount>('mount',mountId);
            if(component.sharedMountId){if(!existing)throw new RackFault('MOUNT_MISSING','Selected shared mount does not exist');this.assertCompatible(existing,component);if(existing.state!=='running')throw new RackFault('MOUNT_UNAVAILABLE','Selected shared mount is not running');}
            else if(existing){this.assertCompatible(existing,component);this.admitMount(mountId,component);existing.desired='running';existing.restarts=0;this.store.put('mount',mountId,existing);await this.ensureRunning(existing);if(existing.state!=='running')throw new RackFault('MOUNT_FAILED',existing.error??'Mount failed');}
            else await this.createMount(mountId,component);
          });}catch(failure){error=failure instanceof RackFault?failure.message:'Managed preparation failed';errorCode=failure instanceof RackFault?failure.code:'BACKEND_UNAVAILABLE';}
          realization.components=realization.components.filter(value=>value.componentId!==component.id);realization.components.push({componentId:component.id,mountId,error,...errorCode?{errorCode}:{},readiness:error?'unavailable':'running',resource:component.resource?.identity??null});this.store.put('realization',realization.id,realization);
        }
        realization.status=realization.components.some(value=>value.error)?'partial':'ready';this.store.put('realization',realization.id,realization);
        // Only the latest explicit apply owns current memberships; historical realization records remain.
        this.store.put('active-realization',revision.environmentId,realization.id);return realization;
      }
      case 'mount.create':await this.managedReady({start:true});return this.createMount(command.id,command.component);
      case 'mount.stop':{
        const mount=this.required<Mount>('mount',command.id);
        if(mount.pendingReleaseId&&!command.force)throw new RackFault('TRANSITION_PENDING','Release replacement is waiting for client release');
        if(mount.pendingReleaseId)for(const op of this.store.list<Operation>('operation'))if(op.state==='waiting'&&op.command.kind==='mount.replace'&&op.command.id===mount.id){op.state='failed';op.error='Replacement cancelled by explicit forced stop';this.store.put('operation',op.id,op);}
        delete mount.pendingReleaseId;return this.stopMount(mount,command.force);
      }
      case 'mount.replace':{
        const mount=this.required<Mount>('mount',command.id);if(mount.pendingReleaseId&&mount.pendingReleaseId!==command.releaseId)throw new RackFault('TRANSITION_PENDING','A different release replacement is waiting for client release');this.validateComponent({...mount.component,releaseId:command.releaseId});
        mount.pendingReleaseId=command.releaseId;this.store.put('mount',mount.id,mount);return this.stopMount(mount,command.force);
      }
      case 'binding.create':if(command.principal==='rack-observer')throw new RackFault('PRINCIPAL_RESERVED','Rack observer identity is reserved');return this.bind(command.mountId,command.operationId,command.principal,command.access);
      case 'binding.release':{
        const binding=this.required<Binding>('binding',command.id);binding.released=true;this.store.put('binding',binding.id,binding);const mount=this.required<Mount>('mount',binding.mountId);await this.writeAuthority(mount);
        if((mount.state==='draining'||mount.pendingReleaseId)&&!this.activeBindings(mount).length)await this.stopMount(mount,false);return {released:true};
      }
    }
  }
  private admitCapabilities(additional:number){if(this.store.list('capability').length+additional>this.config.maxCapabilities)throw new RackFault('CAPABILITY_CAPACITY','Capability catalog capacity reached');}
  private async source(selectedDirectory:string):Promise<CapabilitySource>{
        const selected=await lstat(selectedDirectory);
        if(!selected.isDirectory()||selected.isSymbolicLink())throw new RackFault('SOURCE_DIRECTORY','Choose a regular package directory, not a symlink',400);
        const directory=await realpath(selectedDirectory);
        const repository=await realpath((await runCommand('git',['-C',directory,'rev-parse','--show-toplevel'],this.config.operationTimeoutMs,this.config.maxBodyBytes)).toString().trim());
        const parent=(await runCommand('git',['-C',directory,'rev-parse','--show-superproject-working-tree'],this.config.operationTimeoutMs,this.config.maxBodyBytes)).toString().trim();
        if(parent)throw new RackFault('SOURCE_SUBMODULE','Submodules are not supported capability sources',400);
        // Canonical aliases above the repository (for example macOS /var) are
        // harmless; a link within the selected repository would change its scope.
        for(let current=resolve(selectedDirectory);;current=dirname(current)){
          if((await lstat(current)).isSymbolicLink())throw new RackFault('SOURCE_DIRECTORY','Package source ancestry must not contain symlinks',400);
          if(await realpath(current)===repository)break;
          if(current===dirname(current))throw new RackFault('SOURCE_DIRECTORY','Package is outside its Git repository',400);
        }
        return CapabilitySource.parse({repository,subdirectory:relative(repository,directory)});
  }
  private definitionValue(value:ConnectionRevision){const {origin,id,name,revisionId,baseRevisionId,operationId,createdAt,...definition}=value;return definition;}
  private validateComponent(component:Component){
    if(!('releaseId' in component)){this.definition(component);return;}
    const release=this.release(component.releaseId),validate=this.ajv.compile(release.manifest.configSchema);
    if(!validate(component.configuration))throw new RackFault('CONFIGURATION_INVALID',this.ajv.errorsText(validate.errors));
    // Secret values and host addresses belong to local realization, never portable configuration.
    const inspect=(value:unknown):void=>{if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(/^(password|token|apiKey|secret|endpoint|port|pid|path)$/i.test(key))throw new RackFault('NONPORTABLE_CONFIGURATION',`Use a resource identity or secret reference instead of ${key}`);inspect(item);}};inspect(component.configuration);
  }
  private assertCompatible(mount:Mount,component:ManagedComponent){if(mount.component.releaseId!==component.releaseId||json(mount.component.configuration)!==json(component.configuration)||json(mount.component.resource)!==json(component.resource))throw new RackFault('MOUNT_INCOMPATIBLE','Shared mount release, resource and configuration must match');}
  private admitMount(id:string,component:ManagedComponent){
    const others=this.store.list<Mount>('mount').filter(value=>value.id!==id&&(value.containerId!==null||value.desired==='running'||value.state==='draining'));
    if(others.length>=this.config.maxMounts)throw new RackFault('MOUNT_CAPACITY','Mount capacity reached');
    const accessResources=this.store.list<AccessRecord>('access').filter(value=>value.state!=='released'&&!value.bindings.some(binding=>binding.mountId===id)).flatMap(value=>value.resources);
    if(component.resource&&(others.some(value=>value.component.resource?.identity===component.resource!.identity&&(component.resource!.exclusive||value.component.resource?.exclusive))||accessResources.some(resource=>resource.identity===component.resource!.identity&&(component.resource!.exclusive||resource.exclusive))))throw new RackFault('RESOURCE_BUSY','Resource already has a controller with exclusive ownership');
  }
  private async createMount(id:string,component:ManagedComponent){
    this.validateComponent(component);this.admitMount(id,component);const existing=this.store.get<Mount>('mount',id);if(existing){this.assertCompatible(existing,component);existing.desired='running';existing.restarts=0;this.store.put('mount',id,existing);await this.ensureRunning(existing);if(existing.state!=='running')throw new RackFault('MOUNT_FAILED',existing.error??'Mount failed');return existing;}
    const mount:Mount={id,component,generation:randomUUID(),containerId:null,endpoint:null,desired:'running',state:'starting',error:null,restarts:0,createdAt:new Date().toISOString(),interrupted:false};this.store.put('mount',id,mount);await this.ensureRunning(mount);
    if(mount.state!=='running')throw new RackFault('MOUNT_FAILED',mount.error??'Mount failed');return mount;
  }
  private activeBindings(mount:Mount){return this.store.list<Binding>('binding').filter(value=>value.mountId===mount.id&&value.generation===mount.generation&&!value.released&&value.principal!=='rack-observer');}
  private async writeAuthority(mount:Mount){
    // Preparation/recovery establishes the private context. The actual Docker
    // write detects availability; grants do not probe or prepare infrastructure.
    const authority={generation:mount.generation,bindings:this.store.list<Binding>('binding').filter(value=>value.mountId===mount.id&&value.generation===mount.generation&&!value.released).map(({id,principal,access,hash})=>({id,principal,access,hash}))};
    await this.backend.publishAuthority(mount,this.release(mount.component.releaseId),authority,mount.component.configuration);
  }
  private token(binding:Binding){return createHmac('sha256',this.secret).update(`${binding.id}:${binding.generation}`).digest('base64url');}
  private connection(id:string):Connection{const binding=this.required<Binding>('binding',id),mount=this.required<Mount>('mount',binding.mountId);if(binding.released||binding.generation!==mount.generation||!mount.endpoint)throw new RackFault('BINDING_RELEASED','Binding is no longer usable');return {bindingId:id,mountId:mount.id,releaseId:mount.component.releaseId,generation:mount.generation,url:mount.endpoint,headers:[{name:'Authorization',value:`Bearer ${this.token(binding)}`}]};}
  private async bind(mountId:string,id:string,principal:string,access:'observe'|'call',accessId:string|null=null){
    const mount=this.required<Mount>('mount',mountId);if(mount.state!=='running')throw new RackFault('MOUNT_UNAVAILABLE','Mount is not accepting bindings');
    const existing=this.store.get<Binding>('binding',id);if(existing){if(existing.mountId!==mountId||existing.principal!==principal||existing.access!==access||existing.accessId!==accessId)throw new RackFault('BINDING_CONFLICT','Binding identity already belongs to another grant');await this.writeAuthority(mount);return this.connection(id);}
    if(this.store.list<Binding>('binding').filter(b=>!b.released&&b.mountId===mountId&&b.generation===mount.generation).length>=this.config.maxBindings)throw new RackFault('BINDING_CAPACITY','Mount binding capacity reached');
    const binding:Binding={id,accessId,mountId,generation:mount.generation,principal,access,hash:'',released:false};binding.hash=digest(this.token(binding));this.store.put('binding',id,binding);await this.writeAuthority(mount);return this.connection(id);
  }
  private async ensureRunning(mount:Mount){
    try{
      await this.writeAuthority(mount);
      let state=mount.containerId?await this.backend.inspect(mount.containerId):null;
      if(state&&!state.running){await this.backend.remove(state.id);state=null;mount.containerId=null;}
      if(!state){
        this.admitMount(mount.id,mount.component);
        state=await this.backend.start(mount,this.release(mount.component.releaseId));mount.containerId=state.id;mount.endpoint=state.endpoint;this.store.put('mount',mount.id,mount);
      }
      const deadline=Date.now()+this.config.startupTimeoutMs;let ready=false;
      while(Date.now()<deadline){
        try{const response=await fetch(mount.endpoint!.replace('/mcp','/health'),{signal:AbortSignal.timeout(this.config.observationTimeoutMs)});if(response.ok){ready=true;break;}}catch{}
        const observed=await this.backend.inspect(mount.containerId!);if(!observed?.running)throw new RackFault('SERVER_EXIT','Capability exited before readiness');
        await new Promise(resolve=>setTimeout(resolve,this.config.monitorMs));
      }
      if(!ready)throw new RackFault('READINESS_TIMEOUT','Capability did not become ready');mount.state='running';mount.error=null;this.store.put('mount',mount.id,mount);
    }catch(error){mount.state='failed';mount.error=error instanceof RackFault?error.message:'Managed startup failed';this.store.put('mount',mount.id,mount);console.error(json({event:'mount.failed',mountId:mount.id,error:mount.error}));}
  }
  private async stopMount(mount:Mount,force:boolean){
    mount.desired='stopped';mount.state='draining';this.store.put('mount',mount.id,mount);
    if(!force&&this.activeBindings(mount).length)return mount;
    if(force){mount.interrupted=true;for(const binding of this.store.list<Binding>('binding').filter(value=>value.mountId===mount.id&&!value.released)){binding.released=true;this.store.put('binding',binding.id,binding);}await this.writeAuthority(mount);}
    if(mount.containerId)await this.backend.remove(mount.containerId);mount.containerId=null;mount.endpoint=null;mount.state='stopped';this.store.put('mount',mount.id,mount);
    if(mount.pendingReleaseId){mount.component={...mount.component,releaseId:mount.pendingReleaseId};delete mount.pendingReleaseId;mount.generation=randomUUID();mount.desired='running';mount.restarts=0;mount.error=null;this.store.put('mount',mount.id,mount);await this.ensureRunning(mount);}
    for(const op of this.store.list<Operation>('operation'))if(((op.command.kind==='mount.stop'&&(op.state==='waiting'||op.state==='failed'))||(op.command.kind==='mount.replace'&&op.state==='waiting'))&&op.command.id===mount.id){op.state=this.required<Mount>('mount',mount.id).state==='failed'?'failed':'succeeded';op.result=mount;op.error=mount.error;this.store.put('operation',op.id,op);}
    return mount;
  }
  observe(mountId:string,uri?:string):Promise<Observation>{
    if(this.closing)return Promise.reject(new RackFault('SHUTTING_DOWN','EnvironmentDaemon is shutting down'));
    const pending=this.readObservation(mountId,uri);this.observations.add(pending);void pending.finally(()=>this.observations.delete(pending)).catch(()=>{});return pending;
  }
  private async readObservation(mountId:string,uri?:string):Promise<Observation>{
    const mount=this.required<Mount>('mount',mountId);
    if(this.observing>=this.config.maxObservations)throw new RackFault('OBSERVATION_CAPACITY','Observation capacity reached');this.observing++;
    const key=uri?`${mountId}:${digest(uri)}`:mountId;const previous=this.store.get<Observation>('observation',key);
    const observation:Observation={mountId,generation:mount.generation,releaseId:mount.component.releaseId,source:uri??'mcp:discovery',observedAt:new Date().toISOString(),stale:false,available:false,error:null,tools:[],resources:[]};
    const client=new Client({name:'polariton-observer',version:'1'});const abort=AbortSignal.timeout(this.config.observationTimeoutMs);
    try{
      const connection=await this.withLock(`mount:${mountId}`,()=>{const current=this.required<Mount>('mount',mountId);return this.bind(mountId,`observer-${current.generation}`,'rack-observer','observe');});
      observation.generation=connection.generation;observation.releaseId=connection.releaseId;
      const transport=new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:Object.fromEntries(connection.headers.map(value=>[value.name,value.value]))},fetch:async(input,init)=>{
        const response=await fetch(input,{...init,signal:abort});if(!response.body)return response;
        let size=0;const limited=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform:(chunk,controller)=>{size+=chunk.byteLength;if(size>this.config.maxObservationBytes)throw new RackFault('OBSERVATION_SIZE','Response exceeded observation budget');controller.enqueue(chunk);}}));return new Response(limited,{status:response.status,headers:response.headers});
      }});
      await client.connect(transport,{signal:abort});
      const capabilities=client.getServerCapabilities();
      if(capabilities?.tools)observation.tools=(await client.listTools({}, {signal:abort})).tools;
      if(capabilities?.resources)observation.resources=(await client.listResources({}, {signal:abort})).resources;
      if(uri){const value=await client.readResource({uri},{signal:abort});for(const content of value.contents)if('text' in content&&content.mimeType==='application/json')JSON.parse(content.text);observation.value=value;}
      if(Buffer.byteLength(json(observation))>this.config.maxObservationBytes)throw new RackFault('OBSERVATION_SIZE','Observation exceeded total budget');observation.available=true;
    }catch(error){observation.error=error instanceof RackFault?error.message:'MCP observation failed';observation.stale=true;if(previous&&previous.generation===observation.generation){observation.tools=previous.tools;observation.resources=previous.resources;observation.value=previous.value;observation.observedAt=previous.observedAt;}}
    finally{try{await client.close();}catch(error){console.error(json({event:'observer.close.failed',error:'Managed operation failed'}));}this.observing--;}
    this.store.put('observation',key,observation);return observation;
  }
  private async monitor(){
    if(this.monitoring||this.closing)return;this.monitoring=true;
    try{for(const item of this.store.list<Mount>('mount')){if(this.closing)break;await this.withLock(`mount:${item.id}`,async()=>{
      const mount=this.required<Mount>('mount',item.id);if(mount.desired!=='running')return;
      const state=mount.containerId?await this.backend.inspect(mount.containerId):null;
      if(state?.running)return;
      mount.error=state?.oom?'Container exceeded memory limit':'Capability process exited';mount.state='failed';mount.interrupted=true;
      if(mount.restarts<this.config.restartAttempts){mount.restarts++;this.store.put('mount',mount.id,mount);await this.ensureRunning(mount);}else this.store.put('mount',mount.id,mount);
    });}}catch(error){console.error(json({event:'supervisor.monitor.failed',error:'Managed operation failed'}));}finally{this.monitoring=false;}
  }
  async close(){
    this.closing=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled([...this.locks.values(),...this.observations]);
    const failures:unknown[]=[];for(const mount of this.store.list<Mount>('mount'))if(mount.containerId){try{await this.backend.remove(mount.containerId);mount.containerId=null;mount.endpoint=null;mount.state='stopped';mount.interrupted=this.activeBindings(mount).length>0;this.store.put('mount',mount.id,mount);}catch(error){failures.push(error);}}
    this.store.close();if(failures.length)throw new AggregateError(failures,'Some mounted processes could not be stopped');
  }
}
