import { spawn } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { GuardianLaunch } from './settings.ts';

// The guardian owns the only process-group signalling authority. Its authenticated
// receipt survives Main restart; persisted PIDs never confer signalling authority.
process.once('message', async config => {
  const parsed=GuardianLaunch.safeParse(config);
  if(!parsed.success){process.disconnect();return;}
  const { identity, execution, command, args, cwd, env, limits } = parsed.data;
  const signature = value => createHmac('sha256', identity.token).update(JSON.stringify(value)).digest('hex');
  let child, closing, settled = false, started = false, groupGone = false, nativeSettled = execution==='group';
  const clients = new Set();
  const liveness = new Promise(resolve => { process.once('disconnect', resolve); process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  const present = () => {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if(error.code === 'EPERM')return true; throw error; }
  };
  const signal = value => { try { if (child?.pid) process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; } };
  const waitGone = async timeout => {
    const end = performance.now() + timeout;
    while (present()) { if (performance.now() >= end) return false; await new Promise(resolve => setTimeout(resolve, limits.pollMs)); }
    return true;
  };
  const receipt = async () => {
    const value = { id: identity.id, settled: true, execution };
    const path = join(identity.directory, 'settled.json');
    const temporary=`${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ value, signature: signature(value) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
    const directory = await open(identity.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  };
  const close = () => closing ??= (async () => {
    let stage='draining';
    try {
      if (started && !groupGone) {
        // DSH owns detached native ranges which are outside this process group.
        // Only its fenced, joined execution owner may confirm those ranges gone.
        if(!nativeSettled)nativeSettled=await drainNative(limits.nativeDrainTimeoutMs);
        child.stdin.destroy();
        signal('SIGTERM');
        if (!await waitGone(limits.termTimeoutMs)) { signal('SIGKILL'); if (!await waitGone(limits.killTimeoutMs)) throw new Error('GROUP_UNSETTLED'); }
      }
      groupGone=true;
      if(!nativeSettled){stage='native-execution';throw new Error('NATIVE_EXECUTION_UNCONFIRMED');}
      stage='receipt';await receipt(); settled = true;
      for (const socket of clients) socket.end(JSON.stringify({ id: identity.id, settled: true }) + '\n');
      if (process.connected) process.send({ type: 'settled', id: identity.id });
      server.close(); await unlink(identity.socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
      child?.stdout.destroy(); child?.stderr.destroy(); child?.stdio[3].destroy(); child?.stdio[4]?.destroy();
      process.stdin.destroy(); bridge.destroy();
      if (process.connected) process.disconnect();
    } catch (error) {
      for (const socket of clients) socket.end(JSON.stringify({ id: identity.id, settled: false }) + '\n');
      if (process.connected) process.send({ type: 'unsettled', id: identity.id, stage,code:['EPERM','EACCES','ENOSPC','EIO'].includes(error.code)?error.code:'CLEANUP_UNCONFIRMED' });
      // Remain reachable for an explicit retry. Never manufacture a receipt.
    }
  })().finally(()=>{if(!settled)closing=undefined;});
  const drainNative=timeout=>new Promise(resolve=>{
    const control=child?.stdio[4];
    if(!control||control.destroyed||child.exitCode!==null||child.signalCode!==null)return resolve(false);
    let buffer=Buffer.alloc(0),finished=false;
    const finish=allowed=>{if(finished)return;finished=true;clearTimeout(timer);control.off('data',data);control.off('close',closed);control.off('error',closed);resolve(allowed);};
    const closed=()=>finish(false);
    const data=chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length>limits.maxFrameBytes)return finish(false);
      const end=buffer.indexOf(10);if(end<0)return;
      try{const message=JSON.parse(buffer.subarray(0,end).toString('utf8'));finish(message.id===identity.id&&message.settled===true);}catch{finish(false);}
    };
    const timer=setTimeout(closed,timeout);
    control.on('data',data);control.once('close',closed);control.once('error',closed);
    control.write(JSON.stringify({id:identity.id,method:'drain'})+'\n',error=>{if(error)finish(false);});
  });
  const bridge = new Socket({fd:3, readable:true, writable:true});
  bridge.on('error', () => { void close(); });
  process.stdin.on('error', () => { void close(); });
  process.stdout.on('error', () => { void close(); });
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.setTimeout(limits.requestTimeoutMs, () => socket.destroy());
    socket.on('error', () => clients.delete(socket)); socket.on('close', () => clients.delete(socket));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > limits.maxFrameBytes) { socket.destroy(); return; }
      if (!bytes.includes(10)) return;
      try {
        const request = JSON.parse(bytes.toString('utf8'));
        const supplied = Buffer.from(request.token ?? ''); const expected = Buffer.from(identity.token);
        if (request.id !== identity.id || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.method !== 'close') throw new Error('AUTH');
        clients.add(socket); if(settled)socket.end(JSON.stringify({id:identity.id,settled:true})+'\n');else void close();
      } catch { socket.destroy(); }
    });
  });
  server.maxConnections=limits.maxConnections;
  server.on('error', () => { void close(); });
  try {
    await mkdir(identity.directory, {recursive:true, mode:0o700});
    await mkdir(dirname(identity.socket), {recursive:true, mode:0o700});
    const socketDirectory=await lstat(dirname(identity.socket));
    if(!socketDirectory.isDirectory()||socketDirectory.uid!==process.getuid())throw new Error('GUARDIAN_DIRECTORY');
    await chmod(dirname(identity.socket),0o700);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(identity.socket, resolve); });
    await chmod(identity.socket, 0o600);
    child = spawn(command, args, {cwd, env, detached:true, stdio:['pipe','pipe','pipe','pipe',...(execution==='native'?['pipe']:[])]});
    started = true;
    child.on('error', () => { if(!child.pid)nativeSettled=true;if(process.connected)process.send({type:'failure',id:identity.id,code:'HARNESS_SPAWN_FAILED'});void close(); });
    child.on('exit', () => { void close(); });
    for (const stream of [child.stdin,child.stdout,child.stderr,child.stdio[3],...(execution==='native'?[child.stdio[4]]:[])]) stream.on('error', () => { void close(); });
    // MCP inherits DSH stderr. Consume it without retaining credential-bearing text.
    child.stderr.resume();
    // Main EOF starts guardian-owned drain; it must not concurrently trigger
    // DSH app disposal before the native owner acknowledges that drain.
    process.stdin.pipe(child.stdin,{end:false}); child.stdout.pipe(process.stdout);
    bridge.pipe(child.stdio[3]); child.stdio[3].pipe(bridge);
    process.stdin.on('end', () => { void close(); });
    process.send?.({type:'started', id:identity.id});
    void liveness.then(close);
  } catch { await close(); }
});
// A disconnected Main before the launch message has no owned processes to retire.
process.once('disconnect', () => { if(process.listenerCount('message'))process.exit(0); });
