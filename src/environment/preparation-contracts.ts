import {z} from 'zod';

const Key=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const Path=z.string().min(1).refine(v=>v.startsWith('/')&&!v.includes('\0'),'An absolute path is required');
const reference=/^(?:(?:Bearer|Basic) )?\$\{[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\}$/;
const sensitive=/authorization|cookie|password|token|secret|api.?key|credential|^key$/i;
const Fields=z.record(z.string(),z.string()).refine(fields=>Object.entries(fields).every(([name,value])=>!value.includes('\0')&&(!sensitive.test(name)||reference.test(value))),'Credential values must be private references');
const Headers=Fields.refine(fields=>Object.entries(fields).every(([name,value])=>/^(accept|content-type|user-agent|mcp-protocol-version)$/i.test(name)||reference.test(value)),'Private header values must be references');
const Url=z.string().url().refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash&&![...url.searchParams.keys()].some(name=>sensitive.test(name));},'Use an HTTP URL without credentials or secret query parameters');
const Arguments=z.array(z.string().refine(value=>!value.includes('\0')&&!/(?:password|token|secret|api[-_]?key|authorization|credential)(?:\s|=|:)|^--(?:password|token|secret|api[-_]?key|authorization|credential)$|\bBearer\s/i.test(value),'Secret arguments belong in private credential references'));
export const StorageBinding=z.object({scope:z.enum(['capability','environment']),access:z.enum(['shared','exclusive']),retention:z.literal('retain')}).strict();
const Version=z.string().min(1).max(256);
/** Source selection is independent of launch transport and host lifetime. */
export const SourceSpec=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('npm'),identifier:z.string().min(1),version:Version,executable:z.string().min(1).optional()}).strict(),
 z.object({kind:z.literal('pypi'),identifier:z.string().min(1),version:Version,executable:z.string().min(1).optional()}).strict(),
 z.object({kind:z.literal('nuget'),identifier:z.string().min(1),version:Version,executable:z.string().min(1).optional()}).strict(),
 z.object({kind:z.literal('cargo'),identifier:z.string().min(1),version:Version,executable:z.string().min(1).optional()}).strict(),
 z.object({kind:z.literal('mcpb'),url:Url,sha256:z.string().regex(/^[a-f0-9]{64}$/),configuration:z.record(z.string(),z.union([z.string(),z.array(z.string())])).default({})}).strict(),
 z.object({kind:z.literal('oci'),image:z.string().min(1)}).strict(),
 z.object({kind:z.literal('git'),directory:Path,commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
 z.object({kind:z.literal('installed'),command:Path}).strict(),
 z.object({kind:z.literal('endpoint'),url:Url}).strict(),
]);
export type SourceSpec=z.infer<typeof SourceSpec>;
export const Authentication=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('none')}).strict(),
 z.object({kind:z.literal('static')}).strict(),
 z.object({kind:z.literal('oauth'),connectionId:Key,scopes:z.array(z.string().min(1)).default([])}).strict(),
]);
export type Authentication=z.infer<typeof Authentication>;
/** An owner may amend authentication while a draft is unregistered. Completion
 * resolves only this component; standalone setup prepares its dependencies and never creates an environment. */
export const CapabilityCompleteInput=z.object({target:z.string().regex(/^environment:[a-zA-Z0-9_.-]+$/),expectedVersion:z.number().int().nonnegative(),componentId:Key,authentication:Authentication.optional()}).strict();
export type CapabilityCompleteInput=z.infer<typeof CapabilityCompleteInput>;
export const CapabilitySpec=z.object({
 id:Key,name:z.string().min(1).max(256),source:SourceSpec,
 runtime:z.object({kind:z.enum(['external','local','container']),configuration:z.record(z.string(),z.json()).optional()}).strict(),
 connection:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('stdio'),args:Arguments.default([]),env:Fields.default({})}).strict(),
  z.object({kind:z.literal('http'),url:Url.optional(),headers:Headers.default({})}).strict(),
 ]),
 requirements:z.object({storage:StorageBinding.optional(),files:z.array(Path).default([]),identityFiles:z.array(Path).default([]),assets:z.array(z.object({kind:z.literal('playwright-browser'),browser:z.enum(['chromium','firefox','webkit'])}).strict()).default([]),nativeBuild:z.boolean().default(false),resource:z.object({identity:z.string().min(1),exclusive:z.boolean().default(false)}).strict().optional()}).strict(),
 authentication:Authentication,
 checks:z.array(z.object({name:Key,effects:z.enum(['read','write']),steps:z.array(z.object({tool:z.string().min(1),arguments:z.record(z.string(),z.json())}).strict()).min(1)}).strict()).refine(checks=>new Set(checks.map(check=>check.name)).size===checks.length,'Functional check names must be unique within a component').default([]),
}).strict();
export type CapabilitySpec=z.infer<typeof CapabilitySpec>;
/** Adding a source retains a capability draft before setup performs any effects. */
export const CapabilityAddInput=z.object({
 name:z.string().min(1).max(256),description:z.string().default(''),
 source:z.union([z.string().min(1).refine(value=>!/^https?:/.test(value)||Url.safeParse(value).success,'Source URL must not contain credentials'),SourceSpec]).optional(),
 specification:CapabilitySpec.optional(),
}).strict().refine(value=>Boolean(value.source)!==Boolean(value.specification),'Supply one source or a complete capability specification');
export type CapabilityAddInput=z.infer<typeof CapabilityAddInput>;

/** Creation gets an operation-derived identity. Updates require the complete desired composition. */
export const PreparationInput=z.object({
 name:z.string().min(1).max(256),description:z.string().default(''),source:z.union([z.string().min(1).refine(value=>!/^https?:/.test(value)||Url.safeParse(value).success,'Source URL must not contain credentials'),SourceSpec]).optional(),components:z.array(CapabilitySpec).min(1).optional(),target:Key.optional(),expectRevision:Key.optional(),preview:z.boolean().default(false),
}).strict().superRefine((v,c)=>{
 if(Boolean(v.source)===Boolean(v.components))c.addIssue({code:'custom',message:'Supply one source or a complete component specification'});
 if(Boolean(v.target)!==Boolean(v.expectRevision)||v.target&&v.source)c.addIssue({code:'custom',message:'Updates require target, expectRevision and the complete components array'});
 if(v.components&&new Set(v.components.map(x=>x.id)).size!==v.components.length)c.addIssue({code:'custom',message:'Component IDs must be unique'});
});
export type PreparationInput=z.infer<typeof PreparationInput>;
export const ToolName=z.enum(['node','npm','uv','python','dotnet','cargo','rustc']);
export const PendingAction=z.object({id:Key,componentId:Key.nullable(),code:z.string(),message:z.string(),actor:z.enum(['initiator','owner']),kind:z.enum(['retry','toolchain','authentication','review']),tool:ToolName.optional(),next:z.string()}).strict();
export type PendingAction=z.infer<typeof PendingAction>;
export const ContinueInput=z.object({target:z.string().regex(/^environment:[a-zA-Z0-9_.-]+$/),expectedVersion:z.number().int().nonnegative(),actionId:Key,resolution:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('retry')}).strict(),
 z.object({kind:z.literal('toolchain'),tool:ToolName,path:Path}).strict(),
 z.object({kind:z.literal('authentication-complete')}).strict(),
])}).strict();
export type ContinueInput=z.infer<typeof ContinueInput>;
export const CancellationResult=z.object({cancelled:z.boolean(),operation:z.string()}).strict();
export type CancellationResult=z.infer<typeof CancellationResult>;
export const ValidationInput=z.object({target:Key,revision:Key,check:Key.optional()}).strict();
export type ValidationInput=z.infer<typeof ValidationInput>;
export const Evidence=z.object({registered:z.boolean(),dependencies:z.enum(['unprepared','ready','unavailable']),connection:z.enum(['untested','connected','failed']),tools:z.array(z.string()),authentication:z.enum(['not-required','referenced','connected','action-needed']),checks:z.array(z.object({name:z.string(),status:z.enum(['passed','failed','not-run'])}).strict()),observedAt:z.string().nullable()}).strict();
export const ComponentView=CapabilitySpec.extend({catalogId:Key.nullable().default(null),capabilityId:Key.nullable(),capabilityRevisionId:Key.nullable(),evidence:Evidence,error:z.object({code:z.string(),message:z.string()}).strict().nullable()}).strict();
export type ComponentView=z.infer<typeof ComponentView>;
export const PreparationResult=z.object({status:z.enum(['draft','preview','preparing','ready','partial','blocked','cancelled','failed']),version:z.number().int().nonnegative(),environmentId:Key.nullable(),revisionId:Key.nullable(),components:z.array(ComponentView),actions:z.array(PendingAction),defaults:z.array(z.string()),connection:z.literal('untested'),operationId:z.string()}).strict();
export type PreparationResult=z.infer<typeof PreparationResult>;
/** Retained owner work remains discoverable before a revision exists. Update
 * scope is retained so reviewing a blocked update cannot create a different environment. */
export const PreparationSummary=z.object({name:z.string(),description:z.string(),target:Key.optional(),expectRevision:Key.optional(),result:PreparationResult}).strict();
export type PreparationSummary=z.infer<typeof PreparationSummary>;
export const ValidationResult=z.object({environmentId:Key,revisionId:Key,observedAt:z.string(),scope:z.string(),components:z.array(z.object({componentId:Key,connected:z.boolean(),tools:z.array(z.string()),check:z.object({name:z.string(),status:z.enum(['passed','failed'])}).strict().nullable(),error:z.string().nullable(),cleanup:z.enum(['settled','pending'])}).strict())}).strict();
export type ValidationResult=z.infer<typeof ValidationResult>;
export const Inspection=z.object({environmentId:Key,revisionId:Key,name:z.string(),components:z.array(ComponentView),operations:z.array(z.string()),observations:z.array(ValidationResult)}).strict();
export type Inspection=z.infer<typeof Inspection>;
const InstalledPackage=z.object({name:z.string(),version:z.string()}).strict();
export const PackageInstallation=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),platform:z.string(),arch:z.string(),primary:InstalledPackage.optional(),packages:z.array(InstalledPackage)}).strict();
export type PackageInstallation=z.infer<typeof PackageInstallation>;
/** Catalog facts belong to one exact definition. Connection and check observations
 * remain attached to the environment revision in which they were obtained. */
export const CapabilityInspection=z.object({capabilityId:Key,revisionId:Key,component:ComponentView,installation:PackageInstallation.optional(),environments:z.array(z.object({environmentId:Key,revisionId:Key,name:z.string(),componentId:Key,evidence:Evidence}).strict())}).strict();
export type CapabilityInspection=z.infer<typeof CapabilityInspection>;
