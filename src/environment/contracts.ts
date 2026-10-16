import { z } from 'zod';
import {AccountBinding} from './account-contracts.ts';
import {McpServerPlan} from '../../harness/mcp-contracts.ts';
import {PreparationInput,PreparationResult,PreparationSummary,ContinueInput,ValidationInput,ValidationResult,StorageBinding,CancellationResult,Authentication,CapabilityCompleteInput,CapabilityAddInput,PackageInstallation} from './preparation-contracts.ts';
import {Actor,type Actor as Caller} from '../caller.ts';

export const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const Positive = z.number().int().positive();
const AbsolutePath=z.string().min(1).refine(value=>value.startsWith('/')&&!value.includes('\0'),'Expected an absolute POSIX filesystem path');
const PackageRegistry=z.string().url().refine(value=>{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)));},'Use HTTPS or a loopback HTTP registry without credentials');
const Json: z.ZodType<unknown> = z.json();
export const Limits = z.object({
  memoryMb: Positive.default(512), cpus: z.number().positive().default(1), pids: Positive.default(64),
  scratchMb: Positive.default(128), outputBytes: Positive.default(1048576),
}).strict();
export const ContainerRuntimeConfig=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('external')}).strict(),
  z.object({kind:z.literal('colima'),profile:Key.refine(value=>value!=='default','Use an explicitly provisioned dedicated profile, not the shared default')}).strict(),
]);
export const RackConfig = z.object({
  oauthCallbackPort:z.number().int().min(0).max(65535).default(4329),oauthTimeoutMs:Positive.default(30000),oauthLoginTimeoutMs:Positive.default(600000),oauthRefreshSkewMs:z.number().int().nonnegative().default(30000),maxAccounts:Positive.default(128),maxAccountBytes:Positive.default(1048576),maxOAuthResponseBytes:Positive.default(1048576),
  preparedContainerCapacity:Positive.default(2),
  runtime:ContainerRuntimeConfig.default({kind:'external'}),runtimeStartupTimeoutMs:Positive.default(180000),
  packageTools:z.object({npm:AbsolutePath.optional(),node:AbsolutePath.optional(),uv:AbsolutePath.optional(),python:AbsolutePath.optional(),dotnet:AbsolutePath.optional(),cargo:AbsolutePath.optional(),rustc:AbsolutePath.optional()}).strict().default({}),
  packageRegistry:PackageRegistry.default('https://registry.npmjs.org'),packageIndexUrl:PackageRegistry.default('https://pypi.org/simple'),
  packageTimeoutMs:Positive.default(300000),packageKillGraceMs:Positive.default(15000),maxPackageBytes:Positive.default(1073741824),maxPackageEntries:Positive.default(100000),maxPackageConcurrent:Positive.default(1),packageBuildJobs:Positive.default(2),maxPackageRedirects:Positive.default(5),
  catalogSources:z.record(Key,z.string().min(1)).default({}),
  stateRoot: z.string(), socketPath: z.string(), credentialFile:z.string().optional(), executablePaths:z.array(z.string()).default(['/usr/local/bin','/usr/bin','/bin']), maxCapabilities:Positive.default(1024), maxImportEntries:Positive.default(64), maxIdentityBytes:Positive.default(268435456), dockerConfig:z.string().optional(), dockerSocket:z.string().min(1).optional(), dockerContext: z.string().default('colima-polariton'),
  startupTimeoutMs: Positive.default(60000), shutdownTimeoutMs: Positive.default(15000),
  operationTimeoutMs: Positive.default(300000), observationTimeoutMs: Positive.default(10000),
  observationFreshMs: Positive.default(30000), maxBodyBytes: Positive.default(1048576),
  maxObservationBytes: Positive.default(1048576), maxObservations: Positive.default(4),
  maxMounts: Positive.default(8), maxBindings: Positive.default(64), maxInstalls: Positive.default(1),
  maxArtifactBytes: Positive.default(268435456), maxSourceBytes: Positive.default(67108864),
  maxArchiveEntries: Positive.default(50000), maxBuildCommands: Positive.default(16), maxRecords:Positive.default(10000), maxEnvironments:Positive.default(128), maxRevisions:Positive.default(2048), maxReleases: Positive.default(64),
  cliPageSize:Positive.default(100),
  monitorMs: Positive.default(2000), restartAttempts: z.number().int().nonnegative().default(2),
  limits: Limits.default({memoryMb:512,cpus:1,pids:64,scratchMb:128,outputBytes:1048576}),
  buildLimits: Limits.default({memoryMb:2048,cpus:2,pids:128,scratchMb:1024,outputBytes:4194304}),
}).strict().refine(value=>!value.dockerSocket||Boolean(value.dockerConfig),'dockerSocket requires an explicit private dockerConfig directory').refine(value=>value.runtime.kind!=='colima'||Boolean(value.dockerConfig&&value.dockerSocket),'Owned Colima runtime requires explicit dockerSocket and private dockerConfig');
export type RackConfig = z.infer<typeof RackConfig>;
export type Limits = z.infer<typeof Limits>;
export const Manifest = z.object({
  format: z.literal(1), name: z.string().min(1), description: z.string(),
  image: z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/),
  build: z.array(z.array(z.string().min(1)).min(1)), entrypoint: z.array(z.string().min(1)).min(1),
  lockfiles: z.array(z.string().min(1)).min(1), configSchema: z.record(z.string(), Json),
  mcpPath: z.literal('/mcp'), port: z.literal(8080), state: z.literal('scratch'),
}).strict();
export type Manifest = z.infer<typeof Manifest>;
export const ManagedComponent = z.object({
  id: Key, name: z.string().min(1), releaseId: Key, configuration: z.record(z.string(), Json),
  resource: z.object({identity:z.string().min(1),exclusive:z.boolean().default(false)}).strict().optional(),
  sharedMountId: Key.optional(),
}).strict();
/** External definitions never pretend to be installed releases or persistent mounts. */
export const ConnectionComponent = z.object({
  id:Key,name:z.string().min(1),definition:z.object({capabilityId:Key,revisionId:Key}).strict(),
  resource:z.object({identity:z.string().min(1),exclusive:z.boolean().default(false)}).strict().optional(),
}).strict();
export const Component=z.union([ManagedComponent,ConnectionComponent]);
export type ManagedComponent=z.infer<typeof ManagedComponent>;
export type ConnectionComponent=z.infer<typeof ConnectionComponent>;
export const CredentialIdentity=z.object({account:Key,authority:Key}).strict();
export const FileIdentity=z.object({path:z.string().min(1),realpath:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const Requirements=z.object({
  storage:StorageBinding.optional(),
  files:z.array(z.string().min(1)).default([]),
  identityFiles:z.array(z.string().min(1)).default([]),
  execution:z.literal('foreground-host').default('foreground-host'),
}).strict();
const DefinitionBase={credentials:z.record(Key,CredentialIdentity),requirements:Requirements};
export const HttpDefinition=z.object({...DefinitionBase,kind:z.literal('http'),account:AccountBinding.optional(),url:z.string().url(),headers:z.record(z.string(),z.string())}).strict();
/** A package request is resolved once at Apply; activation consumes its retained installation. */
export const PackageAsset=z.object({kind:z.literal('playwright-browser'),browser:z.enum(['chromium','firefox','webkit'])}).strict();
export const PackageRequest=z.discriminatedUnion('manager',[
  z.object({manager:z.literal('npm'),specifier:z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9*^~.+_-]+)?$/),executable:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),assets:z.array(PackageAsset).optional()}).strict(),
  z.object({manager:z.literal('uv'),specifier:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:==[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/),executable:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),assets:z.array(PackageAsset).optional()}).strict(),
  z.object({manager:z.enum(['nuget','cargo']),identifier:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),version:z.string().regex(/^\d[0-9A-Za-z.+_-]*$/),executable:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),nativeBuild:z.boolean().optional()}).strict(),
  z.object({manager:z.literal('mcpb'),url:PackageRegistry,sha256:z.string().regex(/^[a-f0-9]{64}$/),configuration:z.record(z.string(),z.union([z.string(),z.array(z.string())]))}).strict(),
]);
export type PackageRequest=z.infer<typeof PackageRequest>;
export const StdioDefinition=z.object({...DefinitionBase,kind:z.literal('stdio'),command:z.string(),args:z.array(z.string()),env:z.record(z.string(),z.string()),container:z.object({image:z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/)}).strict().optional(),package:PackageRequest.optional(),identity:z.object({platform:z.string(),arch:z.string(),files:z.array(FileIdentity).min(1)}).strict().optional()}).strict();
export const ConnectionDefinition=z.discriminatedUnion('kind',[HttpDefinition,StdioDefinition]);
export type ConnectionDefinition=z.infer<typeof ConnectionDefinition>;
export const OfficialOrigin=z.object({kind:z.literal('official'),catalogVersion:Key,entryId:Key,version:Key,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const RevisionFields={origin:OfficialOrigin.optional(),id:Key,name:z.string().min(1),revisionId:Key,baseRevisionId:Key.nullable(),operationId:Key,createdAt:z.string()};
export const ConnectionRevision=z.discriminatedUnion('kind',[
  HttpDefinition.extend(RevisionFields),StdioDefinition.extend(RevisionFields),
]);
export type ConnectionRevision=z.infer<typeof ConnectionRevision>;
/** A package is one directory in an immutable commit, rooted in its owning Git working tree. */
export const CapabilitySource=z.object({repository:AbsolutePath,subdirectory:z.string().refine(value=>value===''||(!value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&part!=='.git')),'Expected a canonical repository-relative directory')}).strict();
export type CapabilitySource=z.infer<typeof CapabilitySource>;
export const ManagedCapability=z.object({kind:z.literal('managed'),origin:OfficialOrigin.optional(),id:Key,name:z.string().min(1),source:CapabilitySource,createdAt:z.string()}).strict();
export type ManagedCapability=z.infer<typeof ManagedCapability>;
export const Capability=z.union([ManagedCapability,ConnectionRevision]);
export type Capability=z.infer<typeof Capability>;
/** Distributed definitions are immutable by entry/version; a local source name is resolved only during provisioning. */
export const OfficialEntry=z.object({id:Key,version:Key,name:z.string().min(1).max(256),description:z.string(),prerequisites:z.array(z.string()),configurationRequirements:z.array(z.string()),usageSkills:z.array(z.string()),digest:z.string().regex(/^[a-f0-9]{64}$/),definition:z.union([ConnectionDefinition,z.object({kind:z.literal('managed'),source:Key,subdirectory:CapabilitySource.shape.subdirectory,commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict()])}).strict();
export type OfficialEntry=z.infer<typeof OfficialEntry>;
export const OfficialManifest=z.object({format:z.literal(1),version:Key,entries:z.array(OfficialEntry)}).strict();
export type OfficialManifest=z.infer<typeof OfficialManifest>;
export const OfficialProvision=z.object({entry:OfficialEntry,origin:OfficialOrigin,capabilityId:Key.nullable(),releaseId:Key.nullable()}).strict();
export type OfficialProvision=z.infer<typeof OfficialProvision>;
export const OfficialView=z.object({entry:OfficialEntry,origin:OfficialOrigin,available:z.boolean(),capabilityId:Key.nullable(),releaseId:Key.nullable(),state:z.enum(['unprovisioned','registered','installed'])}).strict();
export const OfficialPage=z.object({catalogVersion:Key,items:z.array(OfficialView),next:z.number().int().nonnegative().nullable()}).strict();
export const OfficialDetail=z.object({catalogVersion:Key,id:Key,versions:z.array(OfficialView)}).strict();
/** Raw import is parsed before any receipt or durable definition is written. */
export const McpConfiguration=z.object({mcpServers:z.record(z.string(),z.unknown())}).strict();
export const PreviewInput=z.object({configuration:McpConfiguration,capabilityId:Key.optional(),resolutions:z.record(z.string(),z.string()).default({})}).strict();
export const ImportEntry=z.object({name:z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),definition:ConnectionDefinition}).strict();
export const ImportPreview=z.object({entries:z.array(ImportEntry),errors:z.array(z.object({name:z.string(),code:z.string(),message:z.string()}).strict()),resolutions:z.record(z.string(),z.string())}).strict();
export type ImportPreview=z.infer<typeof ImportPreview>;
export const ImportResult=z.object({capabilities:z.array(ConnectionRevision)}).strict();
export const Preparation=z.enum(['running','ready-to-connect','ready-to-launch','unavailable']);
/** Public preparation provenance excludes filesystem paths, credentials and launch authority. */
export const ComponentOutcome=z.object({componentId:Key,mountId:Key.nullable(),resource:z.string().nullable(),error:z.string().nullable(),errorCode:z.string().optional(),readiness:Preparation,installation:PackageInstallation.optional()});
export const EnvironmentDocument = z.object({
  format:z.literal(2), environmentId:Key, name:z.string().min(1), description:z.string(),
  components:z.array(Component),
}).strict();
export type EnvironmentDocument = z.infer<typeof EnvironmentDocument>;
export type Component = z.infer<typeof Component>;
export const Revision = EnvironmentDocument.extend({revisionId:Key,baseRevisionId:Key.nullable(),createdAt:z.string(),operationId:Key}).strict();
export type Revision = z.infer<typeof Revision>;
/** A scientific configuration identity; it contains no runtime address or authority. */
export const EnvironmentRef = z.object({environmentId:Key,revisionId:Key,name:z.string().min(1)}).strict();
export type EnvironmentRef = z.infer<typeof EnvironmentRef>;
export const AccessRequest = z.object({id:Key,owner:Key,principal:Key,workspace:AbsolutePath,environment:EnvironmentRef,requireHead:z.boolean()}).strict();
export type AccessRequest = z.infer<typeof AccessRequest>;
export const AccessRelease = z.object({id:Key,owner:Key}).strict();
export const AccessRecord = z.object({id:Key,owner:Key,request:AccessRequest.nullable(),state:z.enum(['acquiring','active','releasing','released']),bindings:z.array(z.object({id:Key,mountId:Key,componentId:Key}).strict()),runtimeComponents:z.array(Key),resources:z.array(z.object({identity:z.string(),exclusive:z.boolean()}).strict()).default([]),error:z.string().nullable()}).strict();
export type AccessRecord = z.infer<typeof AccessRecord>;
export const EnvironmentChoice = z.object({environment:EnvironmentRef,observedAt:z.string()}).strict();
export type EnvironmentChoice = z.infer<typeof EnvironmentChoice>;
export const McpServer=McpServerPlan;
export const ComponentAccess=z.object({componentId:Key,serverName:Key,status:z.enum(['ready','unavailable']),code:z.enum(['PREPARATION_UNAVAILABLE','CONNECTION_UNAVAILABLE','MOUNT_UNAVAILABLE','RESOURCE_BUSY','GRANT_UNAVAILABLE','RUNTIME_UNAVAILABLE']).nullable()}).strict();
export type ComponentAccess=z.infer<typeof ComponentAccess>;
export const AccessGrant = z.object({id:Key,servers:z.array(McpServer),components:z.array(ComponentAccess)}).strict();
export type AccessGrant = z.infer<typeof AccessGrant>;
/** EnvironmentDaemon resolves each component and retains one aggregate cleanup identity. */
export interface EnvironmentAccess { choices():Promise<EnvironmentChoice[]>; acquire(input:AccessRequest):Promise<AccessGrant>; release(input:z.infer<typeof AccessRelease>):Promise<void> }
export const EnvironmentHead = z.object({revisionId:Key,removed:z.object({operationId:Key,removedAt:z.string()}).strict().optional()}).strict();
export type EnvironmentHead = z.infer<typeof EnvironmentHead>;
export const Command = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('environment.prepare'),operationId:Key,input:PreparationInput}).strict(),
  z.object({kind:z.literal('environment.validate'),operationId:Key,input:ValidationInput}).strict(),
  z.object({kind:z.literal('operation.continue'),operationId:Key,input:ContinueInput}).strict(),
  z.object({kind:z.literal('operation.cancel'),operationId:Key,input:z.object({target:z.string().regex(/^environment:[a-zA-Z0-9_.-]+$/)}).strict()}).strict(),
  z.object({kind:z.literal('catalog.provision'),operationId:Key,entryId:Key,version:Key,install:z.boolean().default(false)}).strict(),
  z.object({kind:z.literal('capability.register'),operationId:Key,id:Key.optional(),repository:z.string().min(1)}).strict(),
  z.object({kind:z.literal('capability.import'),operationId:Key,entries:z.array(ImportEntry).min(1)}).strict(),
  z.object({kind:z.literal('capability.revise'),operationId:Key,id:Key,expectedBase:Key,entry:ImportEntry}).strict(),
  z.object({kind:z.literal('capability.add'),operationId:Key,input:CapabilityAddInput}).strict(),
  z.object({kind:z.literal('capability.complete'),operationId:Key,input:CapabilityCompleteInput}).strict(),
  z.object({kind:z.literal('capability.authenticate'),operationId:Key,id:Key,expectedBase:Key,authentication:Authentication}).strict(),
  z.object({kind:z.literal('release.install'),operationId:Key,packageId:Key,commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
  z.object({kind:z.literal('environment.publish'),operationId:Key,expectedBase:Key.nullable(),document:EnvironmentDocument}).strict(),
  z.object({kind:z.literal('environment.remove'),operationId:Key,environmentId:Key,expectedBase:Key}).strict(),
  z.object({kind:z.literal('environment.apply'),operationId:Key,environmentId:Key,revisionId:Key}).strict(),
  z.object({kind:z.literal('mount.create'),operationId:Key,id:Key,component:ManagedComponent}).strict(),
  z.object({kind:z.literal('mount.stop'),operationId:Key,id:Key,force:z.boolean().default(false)}).strict(),
  z.object({kind:z.literal('mount.replace'),operationId:Key,id:Key,releaseId:Key,force:z.boolean().default(false)}).strict(),
  z.object({kind:z.literal('binding.create'),operationId:Key,mountId:Key,principal:Key,access:z.enum(['observe','call'])}).strict(),
  z.object({kind:z.literal('binding.release'),operationId:Key,id:Key}).strict(),
  z.object({kind:z.literal('observe'),mountId:Key,uri:z.string().optional()}).strict(),
]);
export type Command = z.infer<typeof Command>;
export interface Release {origin?:z.infer<typeof OfficialOrigin>;id:string;packageId:string;source:CapabilitySource;commit:string;artifactDigest:string;imageId:string;image:string;manifest:Manifest;locks:Record<string,string>;createdAt:string}
export type MountState='starting'|'running'|'stopped'|'failed'|'draining';
export interface Mount {id:string;component:ManagedComponent;generation:string;containerId:string|null;endpoint:string|null;desired:'running'|'stopped';state:MountState;error:string|null;restarts:number;createdAt:string;interrupted:boolean;pendingReleaseId?:string}
export interface Binding {id:string;accessId:string|null;mountId:string;generation:string;principal:string;access:'observe'|'call';hash:string;released:boolean}
export interface Connection {bindingId:string;mountId:string;releaseId:string;generation:string;url:string;headers:Array<{name:string;value:string}>}
export interface Realization {id:string;environmentId:string;revisionId:string;status:'applying'|'ready'|'partial';components:Array<z.infer<typeof ComponentOutcome>>;createdAt:string}
export interface Observation {mountId:string;generation:string;releaseId:string;source:string;observedAt:string;stale:boolean;available:boolean;error:string|null;tools:unknown[];resources:unknown[];value?:unknown}
export interface Operation {actor:Caller;attempts:Array<{at:string;state:string;error:string|null;errorCode?:string}>;id:string;command:Command;state:'running'|'waiting'|'succeeded'|'failed';result:unknown;error:string|null;errorCode?:string}
export interface Inventory {capabilities:Capability[];releases:Release[];environments:Array<{id:string;head:Revision}>;preparations:PreparationSummary[];mounts:Mount[];realizations:Realization[];activeRealizations:Record<string,string>;operations:Operation[];observations:Observation[];bindings:Array<Omit<Binding,'hash'|'accessId'>>}
export class RackFault extends Error {code:string;status:number;constructor(code:string,message:string,status=409){super(message);this.code=code;this.status=status;}}

// Persisted operational records are validated at the storage boundary, independently of callers.
export const ReleaseRecord = z.object({origin:OfficialOrigin.optional(),id:Key,packageId:Key,source:CapabilitySource,commit:z.string().regex(/^[a-f0-9]{40}$/),artifactDigest:z.string(),imageId:z.string(),image:z.string(),manifest:Manifest,locks:z.record(z.string(),z.string()),createdAt:z.string()}).strict();
const MountRecord=z.object({id:Key,component:ManagedComponent,generation:z.string(),containerId:z.string().nullable(),endpoint:z.string().nullable(),desired:z.enum(['running','stopped']),state:z.enum(['starting','running','stopped','failed','draining']),error:z.string().nullable(),restarts:z.number().int().nonnegative(),createdAt:z.string(),interrupted:z.boolean(),pendingReleaseId:Key.optional()}).strict();
const BindingRecord=z.object({id:Key,accessId:Key.nullable(),mountId:Key,generation:z.string(),principal:z.string(),access:z.enum(['observe','call']),hash:z.string(),released:z.boolean()}).strict();
const RealizationRecord=z.object({id:Key,environmentId:Key,revisionId:Key,status:z.enum(['applying','ready','partial']),components:z.array(ComponentOutcome),createdAt:z.string()}).strict();
const ObservationRecord=z.object({mountId:Key,generation:z.string(),releaseId:Key,source:z.string(),observedAt:z.string(),stale:z.boolean(),available:z.boolean(),error:z.string().nullable(),tools:z.array(Json),resources:z.array(Json),value:Json.optional()}).strict();
export const RecordSchemas:Record<string,z.ZodType>={
  'official-provision':OfficialProvision,access:AccessRecord,
  identity:z.string(),'active-realization':z.string(),
  capability:Capability,'capability-revision':ConnectionRevision,release:ReleaseRecord,mount:MountRecord,binding:BindingRecord,realization:RealizationRecord,observation:ObservationRecord,
  operation:z.object({actor:Actor,attempts:z.array(z.object({at:z.string(),state:z.string(),error:z.string().nullable(),errorCode:z.string().optional()}).strict()),id:Key,command:Command,state:z.enum(['running','waiting','succeeded','failed']),result:Json,error:z.string().nullable(),errorCode:z.string().optional()}).strict(),
};

export const Provenance=z.object({source:CapabilitySource,sourceDigest:z.string(),artifactDigest:z.string(),imageId:z.string(),image:z.string(),commit:z.string(),manifest:Manifest,locks:z.record(z.string(),z.string()),builds:z.array(z.object({argv:z.array(z.string()),output:z.string()}).strict()),dependencies:Json}).strict();
export type Provenance=z.infer<typeof Provenance>;

/** Browser responses expose resource facts, never grant transports or access journals.
 * Dynamic MCP discovery remains opaque JSON owned by the capability. Operation
 * receipts expose status only; callers inspect the corresponding resource for results.
 */
export const BrowserResults={
  'environment.prepare':PreparationResult,
  'environment.validate':ValidationResult,
  'operation.continue':PreparationResult,
  'operation.cancel':CancellationResult,
  'capability.register':ManagedCapability,
  'capability.import':ImportResult,
  'capability.revise':ConnectionRevision,
  'capability.add':PreparationResult,
  'capability.complete':PreparationResult,
  'capability.authenticate':ConnectionRevision,
  'release.install':ReleaseRecord,
  'environment.publish':Revision,
  'environment.remove':z.object({environmentId:Key,operationId:Key,removedAt:z.string()}),
  'environment.apply':RealizationRecord,
  'mount.create':MountRecord,
  'mount.stop':MountRecord,
  'mount.replace':MountRecord,
  'observe':ObservationRecord,
} satisfies Partial<Record<Command['kind'],z.ZodType>>;
export const BrowserInventory=z.object({
  capabilities:z.array(Capability),releases:z.array(ReleaseRecord),
  preparations:z.array(PreparationSummary),
  environments:z.array(z.object({id:Key,head:Revision})),mounts:z.array(MountRecord),
  realizations:z.array(RealizationRecord),activeRealizations:z.record(z.string(),z.string()),
  operations:z.array(z.object({id:Key,command:Command,state:z.enum(['running','waiting','succeeded','failed']),error:z.string().nullable()}).transform(value=>({...value,result:null}))),
  observations:z.array(ObservationRecord),bindings:z.array(BindingRecord.omit({hash:true,accessId:true}).strip()),
});
