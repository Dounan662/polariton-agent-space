import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Fault} from '../contracts.ts';
import {commands,discovery,automaticRequestId,type CommandName} from './contracts.ts';
import {helpEntries} from './help-catalog.ts';

const positive=z.number().int().positive();
/** Release-owned output budgets do not depend on installation state or user config. */
export const HelpPolicy=z.object({rootBytes:positive,inventoryBytes:positive,commandBytes:positive,searchBytes:positive,detailsBytes:positive,schemaBytes:positive,searchLimit:positive,searchMax:positive,queryBytes:positive}).strict().refine(v=>v.searchLimit<=v.searchMax);
export const helpPolicy=Object.freeze(HelpPolicy.parse({rootBytes:4096,inventoryBytes:8192,commandBytes:8192,searchBytes:8192,detailsBytes:16384,schemaBytes:1048576,searchLimit:5,searchMax:20,queryBytes:512}));
const categories={
 research:{name:'Research management',purpose:'Projects, research graphs, nodes, relations and checkpoints. Nodes own workspaces; relations describe connections without scheduling work.',resources:['project','graph','canvas','node','relation','checkpoint']},
 workers:{name:'Worker manipulation',purpose:'Inspect, create, configure and communicate with workers. Workers sharing a node have separate conversations and shared files.',resources:['worker']},
 tools:{name:'Environments and tools',purpose:'Prepare a capability, inspect its exact environment and validate its tools. Definition, installation and validation evidence remain separate.',resources:['catalog','capability','release','environment','mount','binding']},
 system:{name:'Daemon management and recovery',purpose:'Daemon lifecycle and owner command receipts. Retained request identity and outcome recovery apply to every category.',resources:['daemon','operation']},
} as const;
export type HelpCategory=keyof typeof categories;
const categorySchema=z.enum(['research','workers','tools','system']);
const summarySchema=z.object({command:z.string(),category:categorySchema,purpose:z.string(),help:z.string()}).strict();
const argumentSchema=z.object({name:z.string(),type:z.string(),required:z.boolean(),default:z.unknown().optional(),choices:z.array(z.unknown()).optional()}).strict();
const base={helpVersion:z.literal(1),catalog:z.string(),next:z.array(z.string())};
/** Compact views are typed public results, distinct from executable JSON schemas. */
export const HelpView=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('root'),categories:z.array(z.object({selector:categorySchema,name:z.string(),purpose:z.string(),help:z.string()}).strict()),conventions:z.array(z.string())}).strict(),
 z.object({...base,kind:z.literal('inventory'),scope:z.string(),purpose:z.string(),commands:z.array(summarySchema)}).strict(),
 z.object({...base,kind:z.literal('command'),command:z.string(),category:categorySchema,purpose:z.string(),usage:z.string(),inputs:z.array(argumentSchema),clientInputs:z.array(argumentSchema),constraints:z.array(z.string()),example:z.object({command:z.string(),input:z.record(z.string(),z.unknown()).optional(),placeholders:z.string()}).strict(),result:z.string(),details:z.array(z.string()).optional()}).strict(),
 z.object({...base,kind:z.literal('search'),query:z.string(),scope:z.string(),total:z.number().int().nonnegative(),returned:z.number().int().nonnegative(),after:z.number().int().nonnegative(),continuation:z.number().int().nonnegative().nullable(),commands:z.array(summarySchema),hint:z.string()}).strict(),
]);
export type HelpView=z.infer<typeof HelpView>;
type Flags=Record<string,string|boolean>;
const names=Object.keys(commands) as CommandName[];
const commonTools:CommandName[]=['environment.prepare','environment.inspect','environment.validate','environment.list','capability.list','catalog.list'];
const kebab=(value:string)=>value.replace(/[A-Z]/g,c=>`-${c.toLowerCase()}`);
const spelling=(name:CommandName)=>name.replace('.',' ');
function category(name:CommandName):HelpCategory{
 const resource=name.split('.')[0]!;
 const found=(Object.keys(categories) as HelpCategory[]).find(key=>(categories[key].resources as readonly string[]).includes(resource));
 if(!found)throw new Fault('HELP_INVALID',`Command ${name} has no discovery category`);
 return found;
}
const summary=(name:CommandName)=>({command:spelling(name),category:category(name),purpose:commands[name].description,help:`harnessctl ${spelling(name)} --help`});
let identity:string|undefined;
function catalog(){return identity??=createHash('sha256').update(JSON.stringify({version:1,contracts:discovery(),entries:helpEntries,categories,policy:helpPolicy})).digest('hex');}
// NFKC normalization, lower casing and punctuation/whitespace tokenization are
// deterministic. Authored aliases express intent; executable option names cover
// exact CLI vocabulary without guessing through stemming or fuzzy matching.
const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function rank(name:CommandName,query:string){
 const command=normalize(spelling(name));if(command===query)return 5;
 const aliases=helpEntries[name].aliases.map(normalize);if(aliases.includes(query))return 4;
 const options=Object.keys(commands[name].input.shape).filter(key=>key!=='target').map(key=>normalize(kebab(key)));
 if(options.includes(query))return 3;
 const tokens=query.split(' ');
 if(aliases.some(alias=>tokens.every(token=>alias.split(' ').includes(token))))return 2;
 const vocabulary=new Set(normalize(`${command} ${commands[name].description} ${aliases.join(' ')} ${options.join(' ')}`).split(' '));
 return tokens.every(token=>vocabulary.has(token))?1:0;
}
/** Invalid commands point to the nearest executable inventory without guessing a mutation. */
export function unknownCommand(resource?:string):never{
 if(resource&&names.some(name=>name.split('.')[0]===resource))throw new Fault('USAGE',`Unknown command or invalid syntax. Use harnessctl ${resource} --help for valid commands.`,400);
 throw new Fault('USAGE','Unknown help selector or command. Use harnessctl help, or harnessctl help --search "intent"; categories: research, workers, tools, system.',400);
}
function selected(selector:string|undefined):{scope:string;names:CommandName[];purpose:string}{
 if(!selector)return {scope:'all',names,purpose:'All commands'};
 if(Object.hasOwn(categories,selector)){const key=selector as HelpCategory;return {scope:selector,names:names.filter(name=>category(name)===key),purpose:categories[key].purpose};}
 const matches=names.filter(name=>name.split('.')[0]===selector);if(!matches.length)return unknownCommand();
 return {scope:selector,names:matches,purpose:categories[category(matches[0]!)].purpose};
}
function fields(name:CommandName){
 const schema=z.toJSONSchema(commands[name].input,{io:'input'});
 return Object.entries(schema.properties??{}).map(([key,value])=>{
  const property=value as {type?:string|string[];format?:string;enum?:unknown[];default?:unknown;anyOf?:Array<{type?:string}>};
  return {name:key==='target'?'TARGET':`--${kebab(key)}`,type:property.format??(Array.isArray(property.type)?property.type.join('|'):property.type??property.anyOf?.map(v=>v.type??'value').join('|')??'value'),required:name==='canvas.move'&&key==='positions'?false:schema.required?.includes(key)??false,...(Object.hasOwn(property,'default')?{default:property.default}:{}),...(property.enum?{choices:property.enum}:{})};
 });
}
const quote=(value:string)=>/^[a-zA-Z0-9_./:-]+$/.test(value)?value:`'${value.replaceAll("'","'\\''")}'`;
function commandView(name:CommandName,details:boolean):HelpView{
 const entry=helpEntries[name];const inputs=fields(name);
 const clientInputs:z.infer<typeof argumentSchema>[]=[{name:'--input',type:'FILE|-; structured JSON',required:false},{name:'--json',type:'boolean; explicit JSON output (already the default)',required:false,default:false}];
 if((commands[name].mutation&&name!=='canvas.move')||name==='operation.get')clientInputs.push({name:'--details',type:'boolean; full retained receipt instead of compact receipt',required:false,default:false});
 if(commands[name].mutation){clientInputs.push({name:'--request-id',type:'UUID',required:!automaticRequestId(name)&&name!=='environment.publish',...(automaticRequestId(name)?{default:'generated UUID'}:{})});if(name!=='canvas.move')clientInputs.push({name:'--wait',type:'boolean',required:false,default:false});}
 if(name==='operation.get')clientInputs.push({name:'--wait',type:'boolean',required:false,default:false});
 if(name==='worker.evidence'||name==='binding.create'||name==='canvas.snapshot')clientInputs.push({name:'--output',type:'FILE (exclusive creation)',required:name!=='canvas.snapshot'});
 if(name==='worker.send')clientInputs.push({name:'--text-stdin',type:'boolean',required:false,default:false});
 if(name==='worker.create')clientInputs.push({name:'--system-prompt-file',type:'FILE; literal UTF-8',required:false});
 if(name==='worker.get')clientInputs.push({name:'--follow',type:'boolean',required:false,default:false});
 if(name==='canvas.move')clientInputs.push({name:'TARGET',type:'UUID; single-card alternative to positions input',required:false},{name:'--x',type:'number; requires TARGET and --y',required:false},{name:'--y',type:'number; requires TARGET and --x',required:false});
 const constraints=[...entry.notes,'Use bare boolean switches and --flag VALUE for other options, not --flag=VALUE. Structured values use --input FILE or --input -; do not supply the same field twice. [OPTIONS] denotes optional flags listed here, not a literal flag.'];
 if(name==='environment.publish')constraints.push('--request-id UUID is required unless --preview.');
 if(commands[name].mutation&&name!=='canvas.move')constraints.push('Retain request ID and exact payload for recovery; --wait timeout stops observation, not work.');
 const required=inputs.filter(v=>v.required&&!(name==='canvas.move'&&v.name==='--positions')).map(v=>v.name==='TARGET'?'TARGET':`${v.name} ${v.type==='object'||v.type==='array'?'(in JSON input)':v.type.toUpperCase()}`);
 required.push(...clientInputs.filter(v=>v.required).map(v=>`${v.name} ${v.type==='UUID'?'UUID':'FILE'}`));
 const optionalTarget=name==='canvas.move'||inputs.some(v=>v.name==='TARGET'&&!v.required)?' [TARGET]':'';
 const example=`harnessctl ${spelling(name)}${entry.args.length?' '+entry.args.map(quote).join(' '):''}${entry.input?` <<'POLARITON_INPUT'\n${JSON.stringify(entry.input,null,2)}\nPOLARITON_INPUT`:''}`;
 const placeholders='Examples are templates: replace sample IDs/names/paths, EVIDENCE_REFERENCE and OFFERED_OPTION with real discovered values. Match exact revisions to observed state.'+(automaticRequestId(name)?' Omit --request-id for a new operation; retain the generated recovery identity.':commands[name].mutation?' Choose a fresh request UUID for a new mutation.':'');
 return HelpView.parse({helpVersion:1,catalog:catalog(),kind:'command',command:spelling(name),category:category(name),purpose:commands[name].description,usage:`harnessctl ${spelling(name)}${required.length?' '+required.join(' '):''}${optionalTarget} [OPTIONS]`,inputs,clientInputs,constraints,example:{command:example,...(entry.input?{input:entry.input}:{}),placeholders},result:entry.result,...(details?{details:entry.details.length?entry.details:['Use the result’s continuation and retained references to inspect further. This command’s purpose, inputs and constraints above define its ordinary operation.']}:{}),next:[`harnessctl ${name.split('.')[0]} --help`,...(!details?[`harnessctl ${spelling(name)} --help --details`]:[]),`harnessctl ${spelling(name)} --help --schema --json`]});
}
function encoded(value:unknown,json:boolean){return json?JSON.stringify(value)+'\n':JSON.stringify(value,null,2)+'\n';}
/** Text and JSON are renderings of the same complete view; no required field is truncated. */
export function renderHelp(view:HelpView,json:boolean):string{
 if(json)return encoded({version:1,data:view},true);
 const lines=[`harnessctl — ${view.kind==='root'?'command help':view.kind==='inventory'?view.scope:view.kind==='command'?view.command:`search: ${view.query}`}`,`Catalog: ${view.catalog}`];
 if(view.kind==='root'){for(const item of view.categories)lines.push(`\n${item.selector}: ${item.name}\n${item.purpose}\n  ${item.help}`);lines.push('\n'+view.conventions.join('\n'));}
 if(view.kind==='inventory'){lines.push(view.purpose);for(const item of view.commands)lines.push(`${item.command} [${item.category}] — ${item.purpose}\n  ${item.help}`);}
 if(view.kind==='command'){
  lines.push(`Category: ${view.category}`,view.purpose,`\nUsage: ${view.usage}`,'\nInputs:');
  for(const field of [...view.inputs,...view.clientInputs])lines.push(`  ${field.name}: ${field.type}; ${field.required?'required':'optional'}${Object.hasOwn(field,'default')?`; default ${JSON.stringify(field.default)}`:''}${field.choices?`; choices ${field.choices.map(v=>JSON.stringify(v)).join(', ')}`:''}`);
  lines.push('\nConstraints:',...view.constraints.map(v=>`  ${v}`),'\nExample:',view.example.command,view.example.placeholders,`\nResult: ${view.result}`);
  if(view.details)lines.push('\nDetails:',...view.details);
 }
 if(view.kind==='search'){lines.push(`Scope: ${view.scope}; ${view.returned} of ${view.total} matches; after ${view.after}; continuation ${view.continuation??'none'}`);for(const item of view.commands)lines.push(`${item.command} [${item.category}] — ${item.purpose}\n  ${item.help}`);lines.push(view.hint);}
 lines.push('\nNext:',...view.next.map(v=>`  ${v}`));return lines.join('\n')+'\n';
}
function bound(text:string,bytes:number){if(Buffer.byteLength(text)>bytes)throw new Fault('HELP_SIZE_INVALID','Authored help exceeds the installed release budget; report this release error. No fields were truncated.',400);return text;}
/** Local discovery runs before config, input streams, credentials or transports. */
export function helpOutput(words:string[],flags:Flags):string{
 const allowed=new Set(['help','json','schema','details','search','limit','after','config']);
 for(const key of Object.keys(flags))if(!allowed.has(key))throw new Fault('USAGE',`Unsupported help flag --${kebab(key)}`,400);
 if(flags.schema&&(flags.search!==undefined||flags.details))throw new Fault('USAGE','--schema cannot combine with --search or --details; select a command after discovery.',400);
 const helpWords=words[0]==='help'?words.slice(1):words;
 if(helpWords.length>2)return unknownCommand(helpWords[0]);
 const command=helpWords.length===2?helpWords.join('.') as CommandName:undefined;
 if(command&&!Object.hasOwn(commands,command))return unknownCommand(helpWords[0]);
 const selection=command?{scope:command,names:[command],purpose:commands[command].description}:selected(helpWords[0]);
 if(flags.details&&!command)throw new Fault('USAGE','--details requires a selected command, for example harnessctl worker send --help --details.',400);
 if(flags.search===undefined&&(flags.limit!==undefined||flags.after!==undefined))throw new Fault('USAGE','Help --limit and --after require --search.',400);
 if(flags.search!==undefined&&command)throw new Fault('USAGE','Search a category/resource or select command help, not both.',400);
 if(flags.search!==undefined&&flags.details)throw new Fault('USAGE','--details requires a selected command and cannot combine with --search.',400);
 if(flags.schema){
  const {version,commands:schemas,...context}=discovery(selection.names);
  // Invocation schemas lead the explicit export; all response contracts remain
  // present so inspecting inputs never requires scrolling past generic envelopes.
  return bound(encoded({version,commands:schemas,...context},Boolean(flags.json)),helpPolicy.schemaBytes);
 }
 const common={helpVersion:1 as const,catalog:catalog()};let view:HelpView;let budget:number;
 if(flags.search!==undefined){
  const raw=String(flags.search);if(Buffer.byteLength(raw)>helpPolicy.queryBytes)throw new Fault('USAGE',`Search query exceeds ${helpPolicy.queryBytes} UTF-8 bytes.`,400);
  const query=normalize(raw);if(!query)throw new Fault('USAGE','Search requires nonempty words; use harnessctl help to browse.',400);
  const limit=flags.limit===undefined?helpPolicy.searchLimit:Number(flags.limit),after=flags.after===undefined?0:Number(flags.after);
  if(!Number.isSafeInteger(limit)||limit<1||limit>helpPolicy.searchMax||!Number.isSafeInteger(after)||after<0)throw new Fault('USAGE',`Use --limit 1..${helpPolicy.searchMax} and a nonnegative integer --after.`,400);
  const matches=selection.names.map(name=>({name,score:rank(name,query)})).filter(v=>v.score>0).sort((a,b)=>b.score-a.score||(a.name<b.name?-1:a.name>b.name?1:0));
  const page=matches.slice(after,after+limit).map(v=>summary(v.name));
  const make=():HelpView=>HelpView.parse({...common,kind:'search',query:raw,scope:selection.scope,total:matches.length,returned:page.length,after,continuation:after+page.length<matches.length?after+page.length:null,commands:page,hint:matches.length?'Pagination requires the same query, scope and catalog identity; restart after a build change.':'No matches. Broaden the query or browse harnessctl help.',next:after+page.length<matches.length?[`harnessctl help${helpWords[0]?' '+helpWords[0]:''} --search ${quote(raw)} --limit ${limit} --after ${after+page.length}`]:['harnessctl help']});
  view=make();while(page.length&&Buffer.byteLength(renderHelp(view,Boolean(flags.json)))>helpPolicy.searchBytes){page.pop();view=make();}
  if(matches.length>after&&!page.length)throw new Fault('HELP_SIZE_INVALID','A search entry exceeds its release budget.');
  budget=helpPolicy.searchBytes;
 }else if(command){view=commandView(command,Boolean(flags.details));budget=flags.details?helpPolicy.detailsBytes:helpPolicy.commandBytes;
 }else if(helpWords[0]){view=HelpView.parse({...common,kind:'inventory',scope:selection.scope,purpose:selection.purpose,commands:(helpWords[0]==='tools'?commonTools:selection.names).map(summary),next:helpWords[0]==='tools'?['harnessctl operation continue --help',...categories.tools.resources.map(resource=>`harnessctl ${resource} --help`),'harnessctl help tools --search "intent"']:[`harnessctl help ${helpWords[0]} --search "intent"`,'harnessctl <resource> <verb> --help']});budget=helpPolicy.inventoryBytes;
 }else{view=HelpView.parse({...common,kind:'root',categories:(Object.keys(categories) as HelpCategory[]).map(selector=>({selector,name:categories[selector].name,purpose:categories[selector].purpose,help:`harnessctl help ${selector}`})),conventions:['Replace capital placeholders with supplied/discovered values. Use command help for required inputs and a valid example.','Domain results are JSON on stdout; retain stderr separately. Complex input uses --input FILE or --input - (JSON).','Managed workers receive installation and authentication automatically. --config FILE overrides HARNESSCTL_CONFIG, then the packaged default. Domain commands never start missing daemons.','worker send, capability add/complete, environment prepare/validate and operation continue/cancel generate request UUIDs; other mutations require --request-id UUID except previews. Preserve the original recovery identity.','--json selects JSON help and is accepted on domain commands, which already output JSON. With --help, --details expands guidance and --schema exports contracts; on receipt commands, --details returns the full retained receipt. Use bare switches or --flag VALUE, not --flag=VALUE.'],next:['harnessctl help --search "save progress"','harnessctl worker overview --help','harnessctl <resource> <verb> --help','harnessctl --help --schema --json']});budget=helpPolicy.rootBytes;}
 return bound(renderHelp(view,Boolean(flags.json)),budget);
}
