import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { GuardianSettings } from '../harness/settings.ts';
import { JobObservationSettings } from '../harness/settings.ts';
import {CanvasPolicy} from './canvas-contracts.ts';
import {applicationPaths,checkLegacyStorage} from './paths.ts';

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Positive = z.number().int().positive();
const ConfigFields = z.object({
  canvas:CanvasPolicy.prefault({}),
  browserReconnectMs: Positive,
  configPath: z.string().optional(),
  runtimeDirectory:z.string().min(1).optional(),
  cliPollMs: Positive.default(500), cliWaitMs: Positive.default(60000), cliMaxWaitMs: Positive.default(3600000),
  cliMaxRecords: Positive.default(10000), cliPageSize: Positive.default(100), cliMaxStreamBytes: Positive.default(67108864),
  workerOverviewMaxBytes:Positive.default(16384), workerOverviewPageSize:Positive.default(10), workerOverviewTextChars:Positive.default(240),
  workerCredential: z.object({token:z.string(),socket:z.string(),config:z.string()}).optional(), maxBrowserConnections: Positive,
  workerIdentity: z.object({projectId:z.uuid(),nodeId:z.uuid(),workerId:z.uuid()}).strict().optional(),
  sharedSkillsDir:z.string().min(1).optional(), maxWorkerPromptBytes:Positive.default(262144),
  workerIdleUnloadMs:Positive.max(2147483647).nullable().default(360000),
  workerInstructions:z.string().optional(),
  filePageBytes: Positive.default(65536), maxStagedBytes: Positive.default(268435456), maxDirectoryEntries: Positive.default(10000),
  maxSubscriptions: Positive.default(32), maxObservationEvents: Positive.default(2048), maxReconnectMs: Positive.default(15000),
  minPanelWidth: Positive.default(160), minContentWidth: Positive.default(360), keyboardResizeStep: Positive.default(12),
  maxPdfPages: Positive.default(1000), maxPdfPixels: Positive.default(16777216),
  maxFileTabs: Positive.default(16), maxExpandedDirectories: Positive.default(128),
  workspaceDebounceMs: Positive.default(100), workspaceReconcileMs: Positive.default(5000),
  workspaceReadTimeoutMs: Positive.default(10000), maxWorkspaceWatches: Positive.default(512), maxWorkspaceScans: Positive.default(4),
  workspaceReadRetries: z.number().int().nonnegative().default(2),
  checkpointTimeoutMs: Positive.max(2147483647).default(3600000), checkpointMaxProcesses: Positive.default(4),
  checkpointOutputBytes: Positive.default(1048576), checkpointBufferBytes: Positive.default(65536),
  checkpointKillGraceMs: Positive.max(2147483647).default(1000),
  maxImagePixels: Positive.default(16777216), maxDecodedImageBytes: Positive.default(67108864),
  environmentConfig: z.string().optional(),
  workspaceFolderTimeoutMs: Positive.default(10000),
  directoryPickerTimeoutMs: Positive.default(300000),
  campaign: z.string().optional(),
  verificationRerun: z.boolean().default(false),
  port: Positive.max(65535), stateRoot: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  providerDiscoveryTimeoutMs: Positive.default(15000),
  maxPendingMessages: Positive.default(256),
  maxOutputTokens: Positive, maxActiveWorkers: Positive.min(2), requestTimeoutMs: Positive, startupTimeoutMs: Positive,
  mcpStartupTimeoutMs: Positive.default(10000), mcpCleanupTimeoutMs: Positive.default(5000),
  guardian: GuardianSettings,
  jobObservation: JobObservationSettings.prefault({}),
  shutdownTimeoutMs: Positive, maxFrameBytes: Positive, historyPageSize: Positive, maxHistoryEvents: Positive,
  maxFileBytes: Positive, maxWorkspaceFiles: Positive, maxWorkspaceBytes: Positive, maxGraphBytes: Positive,
  permissionTimeoutMs: Positive, historyCutTtlMs: Positive, maxHistoryCuts: Positive, maxBodyBytes: Positive,
  maxHistoryReaders: Positive, historyWorkerMemoryMb: Positive, verification: z.boolean(), maxRequestsPerTurn: Positive, interruptPollMs: Positive, activityDebounceMs: Positive,
}).strict();
export const Config = ConfigFields.refine(value=>value.mcpStartupTimeoutMs+value.mcpCleanupTimeoutMs<value.requestTimeoutMs,
  "MCP startup and cleanup deadlines must fit within requestTimeoutMs").refine(value=>value.guardian.requestTimeoutMs<value.shutdownTimeoutMs,
  "Guardian settlement must fit within the daemon shutdown deadline").refine(value=>value.workerOverviewPageSize<=value.cliPageSize&&value.workerOverviewMaxBytes<=value.cliMaxStreamBytes, "Worker overview limits must fit CLI page and response bounds");
export type Config = z.infer<typeof Config>;
export async function loadConfig(path = resolve(sourceRoot, 'config/app.json')): Promise<Config> {
  const locations=applicationPaths();
  const document=z.record(z.string(),z.unknown()).parse(JSON.parse(await readFile(path,'utf8')));
  if(document.stateRoot===undefined&&!process.env.POLARITON_DATA_DIR&&process.env.POLARITON_PROFILE!=='development'&&resolve(path)===resolve(sourceRoot,'config/app.json'))await checkLegacyStorage(resolve(sourceRoot,'.local/app'));
  const config = Config.parse({stateRoot:resolve(locations.data,'app'),...document});
  const stateRoot=resolve(dirname(path),config.stateRoot);
  const runtimeDirectory=config.runtimeDirectory?resolve(dirname(path),config.runtimeDirectory):document.stateRoot===undefined?locations.runtime:applicationPaths({env:{...process.env,POLARITON_DATA_DIR:stateRoot}}).runtime;
  return { ...config, configPath: resolve(path),runtimeDirectory, sharedSkillsDir:config.sharedSkillsDir?resolve(dirname(path),config.sharedSkillsDir):resolve(stateRoot,'skills'), environmentConfig: config.environmentConfig ? resolve(dirname(path), config.environmentConfig) : undefined, stateRoot, campaign: config.campaign ? resolve(dirname(path), config.campaign) : undefined };
}

export const CampaignConfig = z.discriminatedUnion('id', [
  z.object({id:z.literal('adr020'),ledger:z.string().min(1),maxRequests:Positive.max(20),maxLiveMs:Positive.max(3600000),maxOutputTokens:Positive.max(2048)}).strict(),
  z.object({id:z.literal('adr018'),ledger:z.string().min(1),maxRequests:Positive.max(60),maxLiveMs:Positive.max(3600000),maxOutputTokens:Positive.max(8192),reserveRequests:Positive.min(15),reserveMs:Positive.min(900000)}).strict(),
  z.object({id:z.literal('adr012'),ledger:z.string().min(1),maxRequests:Positive.max(240),maxLiveMs:Positive.max(14400000),maxOutputTokens:Positive.max(8192),reserveRequests:Positive.min(60),reserveMs:Positive.min(3600000)}).strict(),
  z.object({id:z.literal('adr011-packages'),ledger:z.string().min(1),maxRequests:Positive.max(12),maxLiveMs:Positive.max(720000),maxOutputTokens:Positive.max(8192),reserveRequests:Positive.min(4),reserveMs:Positive.min(240000)}).strict(),
  z.object({id:z.literal('adr011'),ledger:z.string().min(1),maxRequests:Positive.max(120),maxLiveMs:Positive.max(7200000),maxOutputTokens:Positive.max(8192),reserveRequests:Positive.min(30),reserveMs:Positive.min(1800000)}).strict(),
  z.object({id:z.literal('adr010'),ledger:z.string().min(1),maxRequests:Positive.max(120),maxLiveMs:Positive.max(7200000),maxOutputTokens:Positive.max(4096),reserveRequests:Positive.min(30),reserveMs:Positive.min(1800000)}).strict(),
  z.object({ id:z.literal('adr009'), ledger:z.string().min(1), maxRequests:Positive.max(120), maxLiveMs:Positive.max(7200000), maxOutputTokens:Positive.max(8192), reserveRequests:Positive.min(30), reserveMs:Positive.min(1800000), maxRepairCycles:Positive.max(3), requestTimeoutMs:Positive }).strict(),
  z.object({ id: z.literal('adr006'), ledger: z.string().min(1), maxRequests: Positive.max(60), maxLiveMs: Positive.max(2400000), maxOutputTokens: Positive.max(4096) }).strict(),
  z.object({ id: z.literal('adr007'), ledger: z.string().min(1), maxRequests: Positive.max(120), maxLiveMs: Positive.max(7200000), maxOutputTokens: Positive.max(8192), reserveRequests: Positive, reserveMs: Positive }).strict(),
]);

export const QualificationConfig = ConfigFields.pick({mcpStartupTimeoutMs:true,mcpCleanupTimeoutMs:true,provider:true,model:true,maxOutputTokens:true,requestTimeoutMs:true,startupTimeoutMs:true,shutdownTimeoutMs:true,maxFrameBytes:true,historyPageSize:true}).extend({maxRequests:Positive,maxLiveMs:Positive});
