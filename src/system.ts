import {pathToFileURL} from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, sourceRoot } from './config.ts';
import { mainControl } from './control.ts';
import { EnvironmentClient, loadRackConfig } from './environment/daemon.ts';

/** Owns the terminal session, not either daemon's domain state. Foreground signals stop
 * both verified peers, including reused owners; --detach explicitly releases that duty. */
export async function runSystem(args:string[],options:{target?:'main'|'environment'|'all';report?:(value:unknown)=>Promise<void>}={}) {
const action = args[0] ?? 'start';
if (!['start', 'stop','status'].includes(action) || args.slice(1).some(value => value.startsWith('--') && !['--no-open', '--detach'].includes(value))) {
  throw new Error('Usage: system.ts start|stop [CONFIG] [--no-open] [--detach]');
}
const configPath = args.slice(1).find(value => !value.startsWith('--'));
const config = await loadConfig(configPath), rackConfig = await loadRackConfig(config.environmentConfig);
const rack = new EnvironmentClient({...rackConfig, operationTimeoutMs:config.shutdownTimeoutMs});
type Status = {ready:boolean; pid:number; launchUrl?:string};
const mainStatus = () => mainControl<Status>(config.stateRoot, '/status', config.shutdownTimeoutMs, config.maxBodyBytes);
const peers = [
  {name:'main', entry:join(sourceRoot, 'src/main.ts'), args:[...(configPath ? [configPath] : []), '--no-open'],
    status:mainStatus, stop:() => mainControl(config.stateRoot, '/stop', config.shutdownTimeoutMs, config.maxBodyBytes), shutdownMs:config.shutdownTimeoutMs},
  {name:'environment', entry:join(sourceRoot, 'src/environment/daemon.ts'), args:config.environmentConfig ? [config.environmentConfig] : [],
    status:() => rack.call<Status>('/v1/health'), stop:() => rack.call('/v1/shutdown', {}),
    // Drain an admitted build/readiness operation before closing mounts sequentially.
    shutdownMs:rackConfig.runtimeStartupTimeoutMs + rackConfig.operationTimeoutMs + rackConfig.startupTimeoutMs + rackConfig.shutdownTimeoutMs * (rackConfig.maxMounts + 1)},
];
const selectedPeers=options.target&&options.target!=='all'?peers.filter(peer=>peer.name===options.target):peers;
const absent = (error:unknown) => ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
const alive = (pid:number) => {try {process.kill(pid, 0); return true;} catch(error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error;}};
const pause = () => new Promise<void>(resolve => setTimeout(resolve, config.interruptPollMs));
const children = new Map<string, {child:ChildProcess; ready:boolean; cancelled:boolean}>();
let stopping = false;
let wake: (() => void) | undefined;
const onSignal = () => {
  if (stopping) return;
  stopping = true;
  // Before a peer has a control socket, only the child we created can be cancelled.
  for (const owned of children.values()) if (!owned.ready && !owned.cancelled && owned.child.exitCode === null && owned.child.signalCode === null) {owned.cancelled = true; owned.child.kill('SIGTERM');}
  wake?.();
};
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);

/** A shutdown acknowledgement starts draining; success means the actual owner exited. */
async function stopAll() {
  const outcomes = await Promise.allSettled(selectedPeers.map(async peer => {
    let pid: number | undefined;
    try {pid = (await peer.status()).pid; await peer.stop();}
    catch (error) {if (!absent(error)) throw error;}
    const owned = children.get(peer.name);
    if (!pid && owned && owned.child.exitCode === null && owned.child.signalCode === null) {
      pid = owned.child.pid;
      if (!owned.ready && !owned.cancelled) {owned.cancelled = true; owned.child.kill('SIGTERM');}
    }
    const deadline = Date.now() + peer.shutdownMs;
    while (pid && alive(pid)) {
      if (Date.now() >= deadline) throw new Error(`${peer.name} did not exit within its shutdown budget; inspect ${peer.name}.log`);
      await pause();
    }
    return {state:'stopped'};
  }));
  const report=Object.fromEntries(outcomes.map((result, index) => [selectedPeers[index]!.name,
    result.status === 'fulfilled' ? result.value : {state:'failed', error:String(result.reason)}]));
  if(options.report)await options.report(report);else console.log(JSON.stringify(report,null,2));
  if (outcomes.some(result => result.status === 'rejected')) process.exitCode = 1;
}

try {
  if(action==='status'){const result=Object.fromEntries(await Promise.all(selectedPeers.map(async peer=>{try{const {launchUrl,...status}=await peer.status();return [peer.name,{state:'ready',...status}];}catch(error){return [peer.name,{state:absent(error)?'stopped':'unavailable'}];}})));if(options.report)await options.report(result);else console.log(JSON.stringify(result));}
  else if (action === 'stop') await stopAll();
  else {
    await mkdir(config.stateRoot, {recursive:true,mode:0o700});
    const results = await Promise.allSettled(selectedPeers.map(async peer => {
      if (stopping) throw new Error('Startup interrupted');
      try {const status = await peer.status(); return {state:'ready', reused:true, status};}
      catch (error) {if (!absent(error)) throw error;}
      if (stopping) throw new Error('Startup interrupted');
      const log = await open(join(config.stateRoot, `${peer.name}.log`), 'a', 0o600);
      let child: ChildProcess;
      let failure: Error | undefined;
      try {
        if (stopping) throw new Error('Startup interrupted');
        child = spawn(process.execPath, [peer.entry, ...peer.args],
          {cwd:sourceRoot, env:process.env, stdio:['ignore', log.fd, log.fd], detached:true});
        children.set(peer.name, {child, ready:false, cancelled:false});
        child.on('error', error => {failure = error;}); child.unref();
      } finally {await log.close();}
      const deadline = Date.now() + config.startupTimeoutMs;
      let last: unknown;
      while (!stopping && Date.now() < deadline) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${peer.name} exited during startup. Inspect ${peer.name}.log`);
        try {
          const status = await peer.status(); children.get(peer.name)!.ready = true;
          return {state:'ready', reused:false, status};
        } catch (error) {last = error;}
        await pause();
      }
      // Timed-out startup must not leave an unreported process coming alive later.
      if (!children.get(peer.name)!.cancelled && child.exitCode === null && child.signalCode === null) {children.get(peer.name)!.cancelled = true; child.kill('SIGTERM');}
      throw new Error(stopping ? 'Startup interrupted' : `${peer.name} did not become ready: ${String(last)}. Inspect ${peer.name}.log`);
    }));
    const report=Object.fromEntries(results.map((result,index)=>[selectedPeers[index]!.name,result.status==='fulfilled'?{...result.value,status:{...result.value.status,launchUrl:undefined}}:{state:'failed',error:String(result.reason)}]));
    if(options.report)await options.report(report);else console.log(JSON.stringify(report,null,2));
    if (stopping) await stopAll();
    else {
      const incomplete = results.some(result => result.status === 'rejected');
      if (incomplete) process.exitCode = 1;
      else {
        const status = results[0]!.status === 'fulfilled' ? results[0]!.value.status : undefined;
        if(!options.report&&status?.launchUrl)console.log(`Polariton: ${status.launchUrl}`);
        if (status?.launchUrl&&!options.report&&!args.includes('--no-open') && !process.env.CI && !process.env.SSH_CONNECTION) {
          const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
          const browser = spawn(command, [status!.launchUrl!], {stdio:'ignore', detached:true});
          browser.on('error', error => console.error(`Browser open failed: ${error.message}`)); browser.unref();
        }
      }
      if (!args.includes('--detach')) {
        const pids = results.flatMap(result => result.status === 'fulfilled' ? [result.value.status.pid] : []);
        if(!options.report)console.log(incomplete ? 'Startup incomplete. Ctrl+C stops both daemons.' : 'Polariton is running. Press Ctrl+C to stop both daemons.');
        // The referenced timer keeps npm's foreground process attached. An external npm stop
        // also releases the terminal once the verified owners have exited.
        while (!stopping && pids.some(alive)) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => {wake = undefined; resolve();}, config.interruptPollMs);
            wake = () => {clearTimeout(timer); wake = undefined; resolve();};
          });
        }
        if (stopping) await stopAll();
      }
    }
  }
} finally {
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
}

}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runSystem(process.argv.slice(2));
