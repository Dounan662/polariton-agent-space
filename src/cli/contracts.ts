import {z} from 'zod';
import {CanvasGetInput,CanvasMoveInput,CanvasSnapshotInput,CanvasFinishInput} from '../canvas-contracts.ts';
import {WorkerOverviewInput} from '../worker-overview-contracts.ts';
import {resultSchema,responseSchemas} from './results.ts';
import {Id,Text,Fault,WorkerInstructions} from '../contracts.ts';
import {Key,EnvironmentDocument,ImportEntry,PreviewInput,ManagedComponent} from '../environment/contracts.ts';
const revision=z.number().int().nonnegative();
const target={target:Id};
const project={project:Id};
const page={after:z.number().int().nonnegative().default(0),limit:z.number().int().positive().optional()};
const edit={expectRevision:revision};
const node={node:Id};
const entry=<S extends z.ZodObject>(input:S,mutation:boolean,description:string)=>({input,mutation,description});
/** One discovery vocabulary is also the wire validator; CLI spelling does not expose owner storage. */
export const commands={
 'project.list':entry(z.object(page).strict(),false,'List retained projects and availability.'),
 'project.get':entry(z.object(target).strict(),false,'Read project location, defaults and initialization.'),
 'project.create':entry(z.object({name:Text,root:z.string().min(1)}).strict(),true,'Create project and defaults; repeat request ID to recover provisioning.'),
 'canvas.get':entry(CanvasGetInput,false,'Inspect browser-local card positions and dimensions; requires a connected project canvas.'),
 'canvas.move':entry(CanvasMoveInput,true,'Position cards atomically in the selected browser canvas; rejects stale edits and active human dragging.'),
 'canvas.snapshot':entry(CanvasSnapshotInput,false,'Capture the connected canvas to a temporary PNG without changing its visible view; --output FILE exports a copy.'),
 'canvas.finish':entry(CanvasFinishInput,false,'Remove this caller’s temporary snapshots for the project; repeat safely, without a connected browser.'),
 'graph.get':entry(z.object(project).strict(),false,'Read bounded complete graph and recovery state.'),
 'graph.history':entry(z.object({...project,...page}).strict(),false,'Page retained graph edits and retractions by sequence.'),
 'graph.repair-tail':entry(z.object(project).strict(),true,'Repair an incomplete final graph record, preserving original bytes.'),
 'node.create':entry(z.object({...project,...edit,title:Text,description:z.string().default(''),fromCheckpoint:Id.optional()}).strict(),true,'Create an independent workspace, optionally inheriting published files.'),
 'node.get':entry(z.object({...target,project:Id.optional()}).strict(),false,'Resolve node metadata, workspace and checkpoint lineage.'),
 'node.update':entry(z.object({...target,...project,...edit,title:Text.optional(),description:z.string().optional(),archived:z.boolean().optional()}).strict().refine(v=>v.archived!==undefined? v.title===undefined&&v.description===undefined : v.title!==undefined||v.description!==undefined,'Change metadata or archival state separately'),true,'Edit node metadata or archival state against graph revision; archival does not stop work.'),
 'relation.create':entry(z.object({...project,...edit,from:Id,to:Id,label:Text,explanation:z.string().default('')}).strict(),true,'Record a descriptive relation; no executable dependency is implied.'),
 'relation.update':entry(z.object({...target,...project,...edit,label:Text.optional(),explanation:z.string().optional()}).strict().refine(v=>v.label!==undefined||v.explanation!==undefined,'Supply a label or explanation'),true,'Edit a retained relation against graph revision.'),
 'relation.retract':entry(z.object({...target,...project,...edit}).strict(),true,'Retract relation without deleting its history.'),
 'worker.list':entry(z.object({...project,node:Id.optional(),...page}).strict(),false,'List workers including archived workers.'),
 'worker.overview':entry(WorkerOverviewInput,false,'Inspect current placement, tools, coworkers and pending attention; defaults to the authenticated worker.'),
 'worker.get':entry(z.object({...target,options:z.boolean().default(false)}).strict(),false,'Read bounded worker state, recent submissions and permissions; options discovers configuration choices.'),
 'worker.create':entry(z.object({...node,title:Text,systemPrompt:WorkerInstructions.optional(),model:z.string().optional(),environment:Key.optional(),revision:Key.optional()}).strict().refine(v=>v.environment===undefined||v.environment==='none'?!v.revision:!!v.revision,'Environment requires an exact revision unless none'),true,'Create an inactive worker; send its first task to start it. Optional role instructions and model/environment; --system-prompt-file captures a local Markdown file.'),
 'worker.update':entry(z.object({...target,title:Text.optional(),archived:z.boolean().optional(),model:z.string().optional(),environment:Key.optional(),revision:Key.optional()}).strict().refine(v=>[v.title,v.archived,v.model,v.environment].filter(x=>x!==undefined).length===1&&(!v.revision||v.environment!==undefined)&&(v.environment===undefined||v.environment==='none'?!v.revision:!!v.revision),'Change exactly one setting; environment requires exact revision unless none'),true,'Change one setting; environment is immutable after first activation, model requires settled work.'),
 'worker.send':entry(z.object({...target,text:z.string().default(''),content:z.array(z.discriminatedUnion('type',[z.object({type:z.literal('text'),text:z.string()}).strict(),z.object({type:z.literal('image'),path:z.string().min(1),mediaType:z.enum(['image/png','image/jpeg','image/gif','image/webp'])}).strict()])).optional()}).strict().refine(v=>!!v.text.trim()||!!v.content?.length,'Supply text or ordered prompt content'),true,'Send a task or reply; starts a newly created inactive worker automatically. Request ID defaults to a new UUID; --wait observes command admission, never recipient turn completion.'),
 'worker.interrupt':entry(z.object(target).strict(),true,'Interrupt current work and retain correlated settlement.'),
 'worker.resume':entry(z.object(target).strict(),true,'Explicitly resume retained session or reopen never-started closed worker; no new input.'),
 'worker.close':entry(z.object(target).strict(),true,'Settle execution, revoke runtime credentials and release access; retain history.'),
 'worker.history':entry(z.object({...target,cut:z.string().optional(),before:z.number().int().nonnegative().optional()}).strict(),false,'Read bounded persisted history without activating a worker.'),
 'worker.evidence':entry(z.object({...target,reference:z.string().min(1)}).strict(),false,'Retrieve retained evidence referenced by history; --output FILE writes exact bytes, never overwrite.'),
 'worker.respond':entry(z.object({...target,request:Id,option:z.string().min(1)}).strict(),true,'Answer an outstanding worker-scoped permission using an offered option.'),
 'checkpoint.publish':entry(z.object({...node,note:Text.optional()}).strict(),true,'Retain shared workspace contents during active work; unfinished files are meaningful. Optional note describes progress.'),
 'checkpoint.list':entry(z.object({...node,...page}).strict(),false,'List published checkpoints.'),
 'checkpoint.get':entry(z.object({...target,...node}).strict(),false,'Read retained commit, file set and publication identity.'),
 'catalog.list':entry(z.object(page).strict(),false,'Inspect distributed official versions and retained provisioning without preparation.'),
 'catalog.get':entry(z.object({target:Key}).strict(),false,'Inspect official entry versions, prerequisites and local provisioning.'),
 'catalog.provision':entry(z.object({target:Key,version:Key,install:z.boolean().default(false)}).strict(),true,'Administratively register an exact official version; --install additionally installs managed releases.'),
 'capability.list':entry(z.object(page).strict(),false,'List registered scientific capabilities.'),
 'capability.get':entry(z.object({target:Key,revision:Key.optional()}).strict(),false,'Inspect head or exact retained capability definition.'),
 'capability.register':entry(z.object({repository:z.string().min(1)}).strict(),true,'Register a managed package directory in a Git repository without executing it; relative paths use the caller working directory.'),
 'capability.preview':entry(PreviewInput,false,'Validate and normalize MCP configuration without execution.'),
 'capability.import':entry(z.object({entries:z.array(ImportEntry).min(1)}).strict(),true,'Register validated connection definitions without execution.'),
 'capability.revise':entry(z.object({target:Key,expectRevision:Key,entry:ImportEntry}).strict(),true,'Publish exact changed connection definition against current revision.'),
 'release.install':entry(z.object({target:Key,commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),true,'Install managed release from exact Git commit; inspect receipt after disconnect.'),
 'release.get':entry(z.object({target:Key}).strict(),false,'Read managed release and retained build provenance.'),
 'environment.list':entry(z.object(page).strict(),false,'List published environments and applied state.'),
 'environment.get':entry(z.object({target:Key,revision:Key.optional()}).strict(),false,'Read head or exact retained environment revision.'),
 'environment.publish':entry(z.object({document:EnvironmentDocument,expectRevision:Key.nullable(),preview:z.boolean().default(false)}).strict(),true,'Publish or preview an environment document; null expected revision creates; publishing does not apply.'),
 'environment.apply':entry(z.object({target:Key,revision:Key}).strict(),true,'Prepare exact revision and retain each component outcome; partial is not ready.'),
 'environment.remove':entry(z.object({target:Key,expectRevision:Key}).strict(),true,'Remove current entry while preserving retained revisions.'),
 'mount.list':entry(z.object(page).strict(),false,'List managed runtime instances.'),
 'mount.get':entry(z.object({target:Key}).strict(),false,'Inspect managed runtime state.'),
 'mount.create':entry(z.object({component:ManagedComponent}).strict(),true,'Start managed runtime with explicit component configuration.'),
 'mount.stop':entry(z.object({target:Key,force:z.boolean().default(false)}).strict(),true,'Stop managed runtime; force is explicit.'),
 'mount.replace':entry(z.object({target:Key,release:Key,force:z.boolean().default(false)}).strict(),true,'Replace runtime release with scoped draining or explicit force.'),
 'mount.observe':entry(z.object({target:Key,uri:z.string().optional()}).strict(),false,'Perform bounded external MCP discovery/resource read; not merely cached state.'),
 'binding.list':entry(z.object(page).strict(),false,'List standalone bindings without credentials.'),
 'binding.get':entry(z.object({target:Key}).strict(),false,'Inspect standalone binding without credentials.'),
 'binding.create':entry(z.object({mount:Key,principal:Key,access:z.enum(['observe','call'])}).strict(),true,'Create standalone connection; credentials require explicit --output FILE and never appear in ordinary output.'),
 'binding.release':entry(z.object({target:Key}).strict(),true,'Release a standalone binding without stopping shared infrastructure.'),
 'operation.get':entry(z.object({target:z.string().regex(/^(main:(research|worker)|environment|daemon:(main|environment)):[a-zA-Z0-9_.-]+$/)}).strict(),false,'Inspect owner command receipt and current result; --wait observes that command, never recipient turn completion.'),
 'daemon.status':entry(z.object({target:z.enum(['main','environment','all']).default('all')}).strict(),false,'Inspect selected installed peers without starting them.'),
 'daemon.start':entry(z.object({target:z.enum(['main','environment','all']).default('all'),detach:z.boolean().default(false)}).strict(),true,'Explicitly start selected peers, foreground by default; no browser is opened.'),
 'daemon.stop':entry(z.object({target:z.enum(['main','environment','all']).default('all')}).strict(),true,'Request peer shutdown and observe process settlement.'),
} as const;
export type CommandName=keyof typeof commands;
export type Command={ [K in CommandName]:{kind:K;input:z.infer<typeof commands[K]['input']>} }[CommandName];
export function parseCommand(kind:string,input:unknown):Command{
 if(!Object.hasOwn(commands,kind))throw new Fault('USAGE','Unknown command; use harnessctl help',400);
 return {kind,input:commands[kind as CommandName].input.parse(input)} as Command;
}
export const Request=z.object({version:z.literal(1),requestId:Id.optional(),command:z.object({kind:z.string(),input:z.unknown()}).strict()}).strict().transform(value=>({...value,command:parseCommand(value.command.kind,value.command.input)})).superRefine((v,c)=>{if(isMutation(v.command)&&!v.requestId)c.addIssue({code:'custom',message:'Mutations require --request-id UUID retained before dispatch'});});
export type Request=z.infer<typeof Request>;
export function isMutation(command:Command){return commands[command.kind].mutation&&!(command.kind==='environment.publish'&&command.input.preview);}
export function environmentCommand(name:string){return ['catalog','capability','release','environment','mount','binding'].includes(name.split('.')[0]!);}
export function discovery(selection?:CommandName|CommandName[]){return {version:1,responses:responseSchemas(),grammar:'harnessctl <resource> <verb> [TARGET_ID] [--flags]',global:{json:'Explicit JSON output; domain execution already emits JSON',details:'Mutation and operation get: full retained owner receipt; with --help: expanded command guidance',config:'FILE',systemPromptFile:'worker create only: bounded literal UTF-8 file captured from caller cwd',input:'FILE|- (structured JSON only)',textStdin:'worker send only: --text-stdin reads literal UTF-8 text from stdin; cannot combine with text or --input -',requestId:'UUID; optional for worker send, required for other mutations. Preserve the original ID for recovery.',expectRevision:'Exact base; none means new environment',wait:'Wait for owner command outcome; worker send waits only for command admission, never message application or recipient turn completion',timeout:'Positive duration such as 30s or 2m',follow:'worker get only: bounded NDJSON observations',output:'Evidence, canvas PNG or binding credential file; exclusive creation',version:'Contract version 1'},commands:Object.fromEntries((selection?(Array.isArray(selection)?selection:[selection]):Object.keys(commands) as CommandName[]).map(key=>[key,{mutation:commands[key].mutation,description:commands[key].description,...((commands[key].mutation&&key!=='canvas.move')||key==='operation.get'?{presentation:{default:'responses.compactReceipt',details:'output',note:'output is the full owner receipt schema; previews return their ordinary result'}}:{}),input:z.toJSONSchema(commands[key].input,{io:'input'}),output:z.toJSONSchema(resultSchema(key))}]))};}
