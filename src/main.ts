import {requireRelease} from '../harness/release.ts';
import {owner} from './caller.ts';
import {commands} from './cli/contracts.ts';
import Fastify from 'fastify';
import {CallerAccess,serveApplication} from './cli/server.ts';
import {Projects,MainOperations} from './cli/main-operations.ts';
import { DirectoryPicker } from './directory-picker.ts';
import { serveControl } from './control.ts';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {parseJsonInput, JsonInputError} from './json-input.ts';
import { Id, Text, Mutation, Fault, UploadPublication, PromptPart, type ProjectView } from './contracts.ts';
import { loadConfig, QualificationConfig, CampaignConfig, sourceRoot, type Config } from './config.ts';
import { ResearchTree } from './research.ts';
import {WorkspaceObserver} from './workspace-observer.ts';
import {WorkspaceScope} from './workspace-contracts.ts';
import {AgentManager} from './agents.ts';
import type {HarnessPort,HarnessFactory} from '../harness/contracts.ts';
import {ProviderSettings,ProviderSettingsError} from '../harness/providers.ts';
import {SaveProvider,RemoveProvider,DefaultProviderRoute,DiscoverProvider} from '../harness/provider-contracts.ts';
import { EnvironmentClient, loadRackConfig } from './environment/daemon.ts';
import { Command as EnvironmentCommand, RackFault, Key as EnvironmentKey, EnvironmentRef, BrowserInventory, BrowserResults, Provenance, Revision, Capability, ConnectionRevision, PreviewInput, ImportPreview } from './environment/contracts.ts';
import { VerificationBudget } from '../harness/budget.mjs';
import {CanvasBridge} from './canvas.ts';
import {CanvasSnapshots} from './canvas-snapshots.ts';

/** Same-origin browser boundary. Domain modules own research; browser canvases own presentation. */
export async function createApp(config: Config, harnessFactory?: HarnessFactory) {
  await requireRelease();
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: config.maxBodyBytes });
  const tree = new ResearchTree(config);
  const canvas=new CanvasBridge(config.canvas);
  let snapshots:CanvasSnapshots|undefined;
  const canvasSockets=new Set<{close:()=>void}>();
  app.addHook('preClose',async()=>{canvas.close();for(const socket of canvasSockets)socket.close();await snapshots?.close();});
  const workspace = new WorkspaceObserver(config,tree,diagnostic=>app.log.warn({...diagnostic,workspace:workspace.stats()}));
  const directoryPicker = new DirectoryPicker({timeoutMs:config.directoryPickerTimeoutMs,maxOutputBytes:config.maxBodyBytes});
  app.addHook('preClose', async () => { directoryPicker.close(); });
  let ownedAgents: AgentManager | undefined;
  let providers: ProviderSettings | undefined;
  let application:Awaited<ReturnType<typeof serveApplication>>|undefined;
  app.addHook('preClose',async()=>{await application?.close();});
  let budget: VerificationBudget | undefined;
  let queued: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const sockets = new Set<{bufferedAmount:number;send:(s:string)=>void; close:()=>void}>();
  // Register ownership cleanup before any fallible initialization acquires resources.
  app.addHook('onClose', async () => {
    workspace.close();
    if (deadline) clearTimeout(deadline);
    if (queued) clearTimeout(queued);
    for (const socket of sockets) socket.close();
    try { await ownedAgents?.close(); }
    finally { try { await providers?.close(); } finally { try { tree.close(); } finally { budget?.close(); } } }
  });
  try {
  tree.on('recovery', value => app.log.warn(value)); await tree.initialize();
  // The existing installation lock also excludes competing snapshot cleanup owners.
  snapshots=await CanvasSnapshots.open(config.stateRoot,config.canvas,error=>app.log.error({err:error},'Temporary canvas snapshot cleanup failed'));
  if (config.verification) {
    const limits = config.campaign ? CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8'))) : QualificationConfig.parse(JSON.parse(await readFile(join(sourceRoot, 'config/qualification.json'), 'utf8')));
    const ledger='ledger' in limits ? resolve(dirname(config.campaign!),limits.ledger) : join(sourceRoot,'.local/verification-budget.sqlite');
    await mkdir(dirname(ledger),{recursive:true});
    if(config.maxOutputTokens>limits.maxOutputTokens) throw new Fault('VERIFICATION_LIMIT','Output token configuration exceeds the authorized verification budget');
    budget = new VerificationBudget(ledger, config.verificationRerun ? {...limits,reserveRequests:0,reserveMs:0} : limits);
  }
  const environment=new EnvironmentClient(await loadRackConfig(config.environmentConfig));
  const access=new CallerAccess(config);await access.initialize();
  const providerSettings=await ProviderSettings.open(join(config.stateRoot,'provider-settings'),{discoveryTimeoutMs:config.providerDiscoveryTimeoutMs,lockTimeoutMs:config.startupTimeoutMs});
  providers=providerSettings;
  const agents = new AgentManager(config, tree, async () => budget?.reserve() ?? true, harnessFactory,{environment,credentials:access,providers:providerSettings});
  ownedAgents = agents;
  await agents.initialize();
  const projectOperations=new Projects(tree,agents);
  const projects=()=>projectOperations.list();
  const initializeProject=(id:string)=>projectOperations.initialize(id);
  for(const project of tree.projects())await initializeProject(project.id);
  const operations=new MainOperations(config,tree,agents,projectOperations,environment,canvas,snapshots);
  application=await serveApplication(config,access,operations);
  let token = randomBytes(32).toString('base64url'); const browserKey = randomBytes(32).toString('base64url');
  let unused = true;
  const origin = `http://127.0.0.1:${config.port}`;
  const secureEqual = (a: unknown, b: string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  await app.register(cookie); await app.register(websocket);
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== `127.0.0.1:${config.port}`) throw new Fault('HOST_DENIED', 'Invalid host', 403);
    if (request.headers.origin && request.headers.origin !== origin) throw new Fault('ORIGIN_DENIED', 'Invalid browser origin', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new Fault('ORIGIN_DENIED', 'Cross-site request denied', 403);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (request.url !== '/api/bootstrap' && !secureEqual(request.cookies.polariton, browserKey)) throw new Fault('AUTH_REQUIRED', 'Open the launch link printed by MainDaemon', 401);
      if (request.method !== 'GET' && request.headers.origin !== origin) throw new Fault('ORIGIN_REQUIRED', 'A same-origin browser request is required', 403);
    }
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'string'},(_request,body,done)=>{try{done(null,parseJsonInput(body as string));}catch(error){done(error as Error);}});
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof JsonInputError) return reply.code(400).send({error:{code:error.code,message:error.message}});
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: request.url.startsWith('/api/settings/providers') ? 'Check the provider fields and try again.' : request.url.startsWith('/api/environment/') ? 'Environment input does not match the supported contract' : error.issues.map(i => i.message).join('; ') } });
    if (error instanceof ProviderSettingsError) {
      const status=error.code==='SETTINGS_CONFLICT'||error.code==='READ_ONLY_CREDENTIAL'?409:error.code==='DISCOVERY_CANCELLED'?408:['SETTINGS_FAILED','SETTINGS_UNREADABLE','CREDENTIAL_SAVE_FAILED','CREDENTIAL_REMOVE_FAILED','DISCOVERY_FAILED'].includes(error.code)?503:400;
      app.log.warn({code:error.code},'Provider settings operation failed');
      return reply.code(status).send({error:{code:error.code,message:error.message}});
    }
    if (error instanceof Fault) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof Error && 'statusCode' in error && (error.statusCode === 400 || error.statusCode === 413)) return reply.code(error.statusCode).send({ error: { code: error.statusCode === 413 ? 'BODY_TOO_LARGE' : 'INVALID_INPUT', message: error.statusCode === 413 ? 'Request exceeds the configured body limit' : 'Malformed request' } });
    if(request.url.startsWith('/api/settings/providers')) {
      app.log.error({code:'PROVIDER_SETTINGS_FAILED'},'Provider settings operation failed');
      return reply.code(500).send({error:{code:'PROVIDER_SETTINGS_FAILED',message:'Provider settings could not be updated. Retry or check local storage permissions.'}});
    }
    app.log.error(error); return reply.code(500).send({ error: { code: 'OPERATION_FAILED', message: 'Operation failed. See MainDaemon diagnostics; retained work has not been deleted.' } });
  });
  app.post('/api/bootstrap', async (request, reply) => {
    const body = z.object({ token: z.string() }).parse(request.body);
    if (!unused || !secureEqual(body.token, token)) throw new Fault('BOOTSTRAP_INVALID', 'Launch link was already used or is invalid', 401);
    unused = false;
    reply.setCookie('polariton', browserKey, { httpOnly: true, sameSite: 'strict', path: '/' }); return { authenticated: true };
  });
  app.get('/api/canvas',{websocket:true},(socket,request)=>{
    if(request.headers.origin!==origin||canvasSockets.size>=config.maxBrowserConnections){socket.close();return;}
    canvasSockets.add(socket);
    const connection=canvas.connect(value=>{
      const text=JSON.stringify(value);
      if(socket.readyState!==1||socket.bufferedAmount+Buffer.byteLength(text)>config.maxFrameBytes){socket.close();throw new Fault('CANVAS_UNAVAILABLE','Browser canvas connection is unavailable or exceeds its frame budget',503);}
      socket.send(text);
    });
    socket.on('message',()=>socket.close());
    socket.on('close',()=>{connection.close();canvasSockets.delete(socket);});
    socket.on('error',(error:Error)=>app.log.warn({code:'CANVAS_CONNECTION',message:error.message},'Canvas browser connection failed'));
  });
  app.post('/api/canvas/:canvas/results',{bodyLimit:Math.ceil(config.canvas.maxImageBytes/3)*4+config.maxBodyBytes},async request=>{
    const params=z.object({canvas:Id}).strict().parse(request.params);
    await canvas.respond(params.canvas,request.body);return {accepted:true};
  });
  // Owner browser access is the sole settings authority. Even a partial write
  // invalidates runtime choices; the provider store marks incomplete routes unusable.
  app.get('/api/settings/providers',async()=>({...await providerSettings.snapshot(),application:agents.providerApplication()}));
  const providerMutation=async(effect:()=>ReturnType<ProviderSettings['snapshot']>)=>{
    try {const snapshot=await effect();agents.providersChanged();return {...snapshot,application:agents.providerApplication()};}
    catch(error){agents.providersChanged();throw error;}
  };
  app.post('/api/settings/providers/save',request=>{const input=SaveProvider.parse(request.body);return providerMutation(()=>providerSettings.save(input));});
  app.post('/api/settings/providers/remove',request=>{const input=RemoveProvider.parse(request.body);return providerMutation(()=>providerSettings.remove(input.id,input.revision));});
  app.post('/api/settings/providers/default',request=>{const input=DefaultProviderRoute.parse(request.body);return providerMutation(()=>providerSettings.setDefault(input.route,input.revision));});
  app.post('/api/settings/providers/discover',async(request,reply)=>{
    const input=DiscoverProvider.parse(request.body),controller=new AbortController();
    const cancel=()=>controller.abort();reply.raw.once('close',cancel);
    try{return await providerSettings.discover(input,controller.signal);}
    finally{reply.raw.off('close',cancel);}
  });
  // Main supplies browser authority; EnvironmentDaemon remains the sole state owner.
  const rackCall=async(path:string,response:z.ZodType,body?:unknown)=>{
    try{return response.parse(await environment.call(path,body));}
    catch(error){if(error instanceof RackFault)throw new Fault(error.code,error.message,error.status);throw new Fault('ENVIRONMENT_UNAVAILABLE','EnvironmentDaemon is unavailable. Project work remains available.',503);}
  };
  app.get('/api/environment/inventory',()=>rackCall('/v1/inventory',BrowserInventory));
  app.post('/api/environment/capabilities/preview',request=>rackCall('/v1/capabilities/preview',ImportPreview,PreviewInput.parse(request.body)));
  app.get('/api/environment/capabilities/:id',request=>{const p=z.object({id:EnvironmentKey}).parse(request.params);return rackCall(`/v1/capabilities/${p.id}`,Capability);});
  app.get('/api/environment/capabilities/:id/revisions/:revision',request=>{const p=z.object({id:EnvironmentKey,revision:EnvironmentKey}).parse(request.params);return rackCall(`/v1/capabilities/${p.id}/revisions/${p.revision}`,ConnectionRevision);});
  app.get('/api/environment/releases/:release/provenance',request=>{const p=z.object({release:EnvironmentKey}).parse(request.params);return rackCall(`/v1/releases/${p.release}/provenance`,Provenance);});
  app.get('/api/environment/revisions/:environment/:revision',async(request,reply)=>{const p=z.object({environment:EnvironmentKey,revision:EnvironmentKey}).parse(request.params);const revision=await rackCall(`/v1/revisions/${p.environment}/${p.revision}`,Revision);return reply.header('Content-Disposition',`attachment; filename="${p.environment}-${p.revision}.json"`).type('application/json').send(revision);});
  app.post('/api/environment/command',request=>{const command=EnvironmentCommand.parse(request.body);if(!Object.hasOwn(BrowserResults,command.kind))throw new Fault('GRANT_DENIED','Worker access is owned by Agent Manager',403);return rackCall('/v1/command',BrowserResults[command.kind as keyof typeof BrowserResults],command);});
  app.get('/api/browser-policy',async()=>({nativePicker:await directoryPicker.availability(),reconnectMs:config.browserReconnectMs,choicesPollMs:config.cliPollMs,historyCacheLimit:config.maxHistoryCuts,maxSubscriptions:config.maxSubscriptions,maxHistoryEvents:config.maxHistoryEvents,maxReconnectMs:config.maxReconnectMs,maxFileBytes:config.maxFileBytes,minPanelWidth:config.minPanelWidth,minContentWidth:config.minContentWidth,keyboardResizeStep:config.keyboardResizeStep,maxPdfPages:config.maxPdfPages,maxPdfPixels:config.maxPdfPixels,maxFileTabs:config.maxFileTabs,maxExpandedDirectories:config.maxExpandedDirectories,filePageBytes:config.filePageBytes,workspaceReadTimeoutMs:config.workspaceReadTimeoutMs,workspaceDebounceMs:config.workspaceDebounceMs,workspaceReconcileMs:config.workspaceReconcileMs,workspaceReadRetries:config.workspaceReadRetries}));
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:config.maxFileBytes},(_request,body,done)=>done(null,body));
  app.post('/api/directories/pick', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    const controller = new AbortController();
    const cancel = () => controller.abort(new Fault('PICKER_CANCELLED', 'Folder selection was cancelled', 408));
    reply.raw.once('close', cancel);
    try { return { path: await directoryPicker.choose(controller.signal) }; }
    finally { reply.raw.off('close', cancel); }
  });
  app.get('/api/projects', projects);
  app.post('/api/projects', async request => {const body=z.object({id:Id,name:Text,root:z.string().min(1).optional()}).strict().parse(request.body);return projectOperations.create(body.id,body.name,body.root);});
  const project = (params: unknown) => z.object({ project: Id }).parse(params).project;
  const node = (params: unknown) => z.object({ project: Id, node: Id }).parse(params);
  const worker = (params: unknown) => z.object({ project: Id, node: Id, workerId: Id }).parse(params);
  const base = '/api/projects/:project';
  app.post(`${base}/rename`,request=>tree.renameProject(project(request.params),z.object({name:Text}).strict().parse(request.body).name));
  app.post(`${base}/initialize`,async request=>{const id=project(request.params);if(!tree.projects().some(p=>p.id===id))throw new Fault('PROJECT_NOT_FOUND','Project does not exist',404);await initializeProject(id);return projects().find(p=>p.id===id)!;});
  app.get(`${base}/activity`,request=>agents.activity(project(request.params)));
  app.get(`${base}/graph`, request => tree.graph(project(request.params)));
  app.post(`${base}/graph`, request => tree.mutate(project(request.params), Mutation.parse(request.body)));
  app.post(`${base}/repair`, request => tree.repair(project(request.params)));
  app.get(`${base}/nodes/:node/files`, request => { const p = node(request.params),q=z.object({path:z.string().default('')}).parse(request.query); return tree.directory(p.project, p.node,q.path); });
  app.get(`${base}/nodes/:node/file`, async request => {
    const p=node(request.params),q=z.object({path:z.string().min(1),offset:z.coerce.number().int().nonnegative().default(0),version:z.string().optional(),length:z.coerce.number().int().positive().max(config.maxFileBytes).optional()}).parse(request.query);
    return tree.readPage(p.project,p.node,q.path,q.offset,q.version,q.length);
  });
  app.get(`${base}/nodes/:node/media`,async(request,reply)=>{
    const p=node(request.params),q=z.object({path:z.string().min(1),version:z.string().min(1)}).parse(request.query);
    const bytes=await tree.file(p.project,p.node,q.path),{createHash}=await import('node:crypto');
    if(createHash('sha256').update(bytes).digest('hex')!==q.version)throw new Fault('FILE_CHANGED','File changed; reopen the preview');
    const extension=q.path.split('.').at(-1)?.toLowerCase(),media=extension==='png'?'image/png':extension==='jpg'||extension==='jpeg'?'image/jpeg':extension==='gif'?'image/gif':extension==='webp'?'image/webp':extension==='pdf'?'application/pdf':'text/plain; charset=utf-8';
    if(media==='application/pdf')reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; sandbox");
    return reply.type(media).send(bytes);
  });
  app.post(`${base}/nodes/:node/uploads`,{bodyLimit:config.maxFileBytes},async request=>{
    const p=node(request.params),input=UploadPublication.parse(request.query);
    if(!Buffer.isBuffer(request.body))throw new Fault('UPLOAD_BYTES','Send binary file bytes',400);
    return tree.stageUpload(p.project,p.node,input,request.body);
  });
  app.post(`${base}/nodes/:node/uploads/publish`,request=>{const p=node(request.params);return tree.publishUpload(p.project,p.node,UploadPublication.parse(request.body));});
  app.get(`${base}/nodes/:node/checkpoints`, request => { const p = node(request.params); return tree.checkpoints(p.project, p.node); });
  app.post(`${base}/nodes/:node/checkpoints`, request => {
    const p = node(request.params), body = z.object({ id: Id, note: Text.optional() }).strict().parse(request.body);
    return tree.checkpoint(p.project, p.node, body.id, {publisher:owner,...body.note?{note:body.note}:{}});
  });
  const workers = `${base}/nodes/:node/workers`;
  app.get(workers, request => { const p = node(request.params); return agents.list(p.project, p.node); });
  app.post(workers, async request => { const p=node(request.params),{id,...body}=z.object({id:Id}).passthrough().parse(request.body); const resolved=tree.resolveNode(p.node,p.project),input=commands['worker.create'].input.parse({...body,node:resolved.node.id}); return (await operations.createWorker(id,owner,input,id)).result; });
  app.post(`${workers}/:workerId/rename`,request=>{const p=worker(request.params),body=z.object({title:Text}).strict().parse(request.body);return agents.rename(p.project,p.node,p.workerId,body.title);});
  app.post(`${workers}/:workerId/archive`,request=>{const p=worker(request.params),body=z.object({archived:z.boolean()}).parse(request.body);return agents.archive(p.project,p.node,p.workerId,body.archived);});
  app.post(`${workers}/:workerId/configure`,request=>{const p=worker(request.params),body=z.object({configId:z.string(),value:z.string()}).parse(request.body);return agents.configure(p.project,p.node,p.workerId,body.configId,body.value);});
  app.get(`${workers}/:workerId/setup`,request=>{const p=worker(request.params);return agents.setup(p.project,p.node,p.workerId);});
  app.post(`${workers}/:workerId/environment`,request=>{const p=worker(request.params),body=z.object({selection:EnvironmentRef.nullable()}).strict().parse(request.body);return agents.selectEnvironment(p.project,p.node,p.workerId,body.selection);});
  app.get(`${workers}/:workerId/submissions/:submissionId`,request=>{const p=worker(request.params),q=z.object({submissionId:Id}).parse(request.params);return agents.readSubmission(p.project,p.node,p.workerId,q.submissionId);});
  app.post(`${workers}/:workerId/submissions/:submissionId/retry`,request=>{const p=worker(request.params),body=z.object({submissionId:Id}).parse(request.params);return agents.retry(p.project,p.node,p.workerId,body.submissionId);});
  app.post(`${workers}/:workerId/images`,{bodyLimit:config.maxFileBytes},request=>{const p=worker(request.params),q=z.object({id:Id,name:Text,mediaType:z.enum(['image/png','image/jpeg','image/gif','image/webp'])}).parse(request.query);if(!Buffer.isBuffer(request.body))throw new Fault('IMAGE_BYTES','Send image bytes',400);return agents.stageImage(p.project,p.node,p.workerId,q.id,q.name,q.mediaType,request.body);});
  app.post(`${workers}/:workerId/resume`, async request => { const p = worker(request.params); await agents.resume(p.project, p.node, p.workerId); return { resumed: true }; });
  app.post(`${workers}/:workerId/close`, async request => { const p = worker(request.params); await agents.closeWorker(p.project, p.node, p.workerId); return { closed: true }; });
  app.post(`${workers}/:workerId/submissions`, request => {
    const p = worker(request.params), body = z.union([z.object({id:Id,text:z.string().max(config.maxBodyBytes),content:z.array(PromptPart).max(config.maxObservationEvents).optional()}).strict(),z.object({id:Id,kind:z.literal('interrupt'),text:z.string().max(config.maxBodyBytes)}).strict()]).parse(request.body);
    if (!('kind' in body) && !body.text.trim()&&!body.content?.some(part=>part.type==='image'||part.text.trim())) throw new Fault('EMPTY_MESSAGE', 'Enter a message', 400);
    return agents.submit(p.project, p.node, p.workerId, body);
  });
  app.post(`${workers}/:workerId/permissions`, request => {
    const p = worker(request.params), body = z.object({ id: Id, option: z.string() }).parse(request.body);
    agents.permission(p.project, p.node, p.workerId, body.id, body.option); return { answered: true };
  });
  app.get(`${workers}/:workerId/history`, request => {
    const p = worker(request.params), q = z.object({ cut: z.string().optional(), before: z.coerce.number().int().nonnegative().optional() }).parse(request.query);
    return agents.history(p.project, p.node, p.workerId, q.cut, q.before);
  });
  app.get(`${workers}/:workerId/staged-image`,async(request,reply)=>{const p=worker(request.params),q=z.object({id:Id}).parse(request.query);const image=await agents.stagedImage(p.project,p.node,p.workerId,q.id);return reply.type(image.mediaType).send(image.bytes);});
  app.get(`${workers}/:workerId/image`,async(request,reply)=>{const p=worker(request.params),q=z.object({id:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).parse(request.query);const image=await agents.image(p.project,p.node,p.workerId,q.id);return reply.type(image.mediaType).send(image.bytes);});
  app.get(`${workers}/:workerId/attachment`, async (request, reply) => {
    const p = worker(request.params), q = z.object({ cut: Id, seq: z.coerce.number().int().nonnegative(), index: z.coerce.number().int().nonnegative() }).parse(request.query);
    const attachment = await agents.attachment(p.project, p.node, p.workerId, q.cut, q.seq, q.index);
    if (attachment.mediaType === 'application/octet-stream') reply.header('Content-Disposition', 'attachment; filename="attachment"');
    return reply.type(attachment.mediaType).send(attachment.bytes);
  });
  const watchCommand=z.discriminatedUnion('kind',[
    z.object({kind:z.literal('subscribe'),project:Id,node:Id,workerId:Id}),
    z.object({kind:z.literal('unsubscribe'),workerId:Id}),
    z.object({kind:z.literal('workspace-subscribe'),scope:WorkspaceScope}),
    z.object({kind:z.literal('workspace-unsubscribe'),scope:WorkspaceScope}),
  ]);
  const rebaseline=new Set<()=>void>();
  app.get('/api/live', { websocket: true }, (socket, request) => {
    if (request.headers.origin !== origin || sockets.size>=config.maxBrowserConnections) { socket.close(); return; }
    sockets.add(socket);
    type Notice={project:string;node:string;workerId:string;process:string|null;kind:string;event?:{seq:number};frame?:{revision:number}};
    type Watch={project:string;node:string;workerId:string;generation:string;process:string|null;opening:boolean;queue:Notice[];sequence:number;cursor:number;revision:number};
    const watching=new Map<string,Watch>();
    const workspaceWatches=new Map<string,()=>void>();
    const send=(value:unknown)=>{const text=JSON.stringify(value);if(socket.bufferedAmount+Buffer.byteLength(text)>config.maxFrameBytes){socket.close();return;}socket.send(text);};
    const forward=(watch:Watch,notice:Notice)=>{
      if(notice.process!==watch.process){void opening(watch.project,watch.node,watch.workerId);return;}
      if(notice.kind==='event' && notice.event!.seq<=watch.cursor)return;
      if(notice.kind==='assistant-stream' && notice.frame!.revision<=watch.revision)return;
      if(notice.event)watch.cursor=notice.event.seq;
      if(notice.frame)watch.revision=notice.frame.revision;
      send({...notice,generation:watch.generation,sequence:++watch.sequence});
    };
    const opening=async(project:string,node:string,workerId:string)=>{
      if(!watching.has(workerId)&&watching.size>=config.maxSubscriptions)throw new Fault('SUBSCRIPTION_LIMIT','Too many worker subscriptions');
      const watch:Watch={project,node,workerId,generation:randomBytes(16).toString('hex'),process:null,opening:true,queue:[],sequence:0,cursor:-1,revision:0};
      watching.set(workerId,watch);
      try {
        const snapshot=await agents.observe(project,node,workerId);
        if(watching.get(workerId)!==watch)return;
        watch.process=snapshot.process;watch.cursor=snapshot.cursor;watch.revision=snapshot.assistantStream.revision;
        send({kind:'snapshot',project,node,workerId,generation:watch.generation,sequence:0,...snapshot});
        watch.opening=false;for(const notice of watch.queue)forward(watch,notice);watch.queue=[];
      } catch(error) {
        if(watching.get(workerId)!==watch)return;
        watching.delete(workerId);send({kind:'observation-error',workerId,error:error instanceof Error?error.message:String(error)});
      }
    };
    const notice=(value:Notice)=>{
      const watch=watching.get(value.workerId);if(!watch||watch.project!==value.project||watch.node!==value.node)return;
      if(watch.opening){if(watch.queue.length>=config.maxObservationEvents){watching.delete(value.workerId);send({kind:'observation-error',worker:value.workerId,error:'Observation buffer exhausted; reconnecting is required'});}else watch.queue.push(value);}
      else forward(watch,value);
    };
    const reconcile=()=>{for(const watch of watching.values()){
      if(watch.opening)continue;
      const worker=agents.list(watch.project,watch.node).find(value=>value.id===watch.workerId);
      if(worker && worker.state!=='starting' && (['idle','running','interrupting'].includes(worker.state)?worker.processId:null)!==watch.process)void opening(watch.project,watch.node,watch.workerId);
    }};
    rebaseline.add(reconcile);agents.on('observation',notice);
    socket.on('message',(raw:Buffer)=>{void(async()=>{
      if(raw.length>config.maxBodyBytes)throw new Fault('FRAME_LIMIT','Subscription command exceeds configured limit');
      const command=watchCommand.parse(JSON.parse(raw.toString()));
      if(command.kind==='workspace-subscribe'||command.kind==='workspace-unsubscribe') {
        const scope=command.scope,key=JSON.stringify(scope);
        workspaceWatches.get(key)?.();workspaceWatches.delete(key);
        if(command.kind==='workspace-subscribe') {
          try {
            if(workspaceWatches.size>=config.maxExpandedDirectories+config.maxFileTabs+1)throw new Fault('SUBSCRIPTION_LIMIT','Too many workspace subscriptions');
            workspaceWatches.set(key,workspace.subscribe(scope,change=>{
              send({kind:'workspace-change',...change});
              if(change.terminal){workspaceWatches.get(key)?.();workspaceWatches.delete(key);}
            }));
          } catch(error) {send({kind:'workspace-change',scope,state:'unavailable',detail:error instanceof Error?error.message:String(error)});}
        }
      } else if(command.kind==='unsubscribe')watching.delete(command.workerId);else await opening(command.project,command.node,command.workerId);
    })().catch(error=>send({kind:'error',error:String(error)}));});
    socket.on('close',()=>{sockets.delete(socket);for(const release of workspaceWatches.values())release();workspaceWatches.clear();watching.clear();agents.off('observation',notice);rebaseline.delete(reconcile);});
    send({kind:'refresh'});
  });
  const change = () => {
    if (queued) return;
    queued = setTimeout(() => { queued = undefined; for(const reconcile of rebaseline)reconcile(); for (const socket of sockets) { if(socket.bufferedAmount>config.maxFrameBytes)socket.close();else socket.send(JSON.stringify({ kind: 'refresh' })); } }, config.activityDebounceMs);
  };
  tree.on('change', change); agents.on('change', change);
  agents.on('failure', value => app.log.error(value));
  agents.on('unloaded',value=>app.log.info({...value,event:'worker.unloaded'}));
  await app.register(staticFiles, { root: join(sourceRoot, 'dist/web'), wildcard: true });
  deadline = budget ? setTimeout(() => { app.log.warn('Verification live time budget reached; stopping execution'); void app.close(); }, budget.remainingMs) : undefined;
  return { app, tree, agents, get launchUrl(){return `${origin}/#token=${token}`;}, renewLaunch(){token=randomBytes(32).toString('base64url');unused=true;return `${origin}/#token=${token}`;} };
  } catch (error) {
    try { await app.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Startup and resource cleanup failed'); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await loadConfig(process.argv.slice(2).find(arg=>!arg.startsWith('--')));
  const runtime = await createApp(config);
  let closeControl:(()=>Promise<void>)|undefined;
  runtime.app.addHook('onClose',async()=>{await closeControl?.();});
  await runtime.app.listen({ host: '127.0.0.1', port: config.port });
  closeControl=await serveControl(config.stateRoot,()=>({ready:true,pid:process.pid,launchUrl:runtime.renewLaunch()}),()=>runtime.app.close());
  console.log(`Polariton: ${runtime.launchUrl}`);
  if(!process.argv.includes('--no-open')&&!process.env.SSH_CONNECTION&&!process.env.CI&&(process.platform!=='linux'||process.env.DISPLAY||process.env.WAYLAND_DISPLAY)) {
    const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
    const child=spawn(command,[runtime.launchUrl],{stdio:'ignore',detached:true});child.on('error',()=>console.warn('Browser could not be opened. Use the printed launch link.'));child.unref();
  }
  const stop = () => { void runtime.app.close().catch(error => { console.error('Shutdown failed:', error.message); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
