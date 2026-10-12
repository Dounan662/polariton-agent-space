import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

import {GuardianIdentity,GuardianSettings,GuardianLaunch,runtimeSocketPath} from './settings.ts';

/** A private capability authenticates a single guardian and its durable settlement. */
export function guardianIdentity(home,runtimeDirectory,socketPathBytes) {
  const id = randomUUID();
  return {id, token:randomBytes(32).toString('hex'), directory:join(home,'guardians',id), socket:runtimeSocketPath(runtimeDirectory??join('/tmp',`polariton-guardian-${process.getuid()}`),id,socketPathBytes)};
}

/** Confirm termination through the owning guardian, never by probing persisted PIDs. */
export async function settleGuardian(identity, limits, execution) {
  z.enum(['native','group']).parse(execution);
  const settled = async () => {
    try {
      const record = JSON.parse(await readFile(join(identity.directory,'settled.json'),'utf8'));
      if (record.value?.id !== identity.id || record.value?.settled !== true || record.value?.execution !== execution) return false;
      const expected = createHmac('sha256',identity.token).update(JSON.stringify(record.value)).digest();
      const actual = Buffer.from(record.signature,'hex');
      return expected.length === actual.length && timingSafeEqual(expected,actual);
    } catch { return false; }
  };
  if(await settled())return;
  const confirmed = await new Promise(resolve => {
    const socket = connect(identity.socket); let buffer = Buffer.alloc(0);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(limits.requestTimeoutMs, () => finish(false));
    socket.on('error', () => finish(false)); socket.on('end', () => finish(false));
    socket.on('connect', () => socket.write(JSON.stringify({id:identity.id,token:identity.token,method:'close'})+'\n'));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer,chunk]);
      if(buffer.length > limits.maxFrameBytes)return finish(false);
      if(!buffer.includes(10))return;
      try { const result=JSON.parse(buffer.toString('utf8')); finish(result.id===identity.id && result.settled===true); } catch { finish(false); }
    });
  });
  if(!await settled())throw new Error(confirmed?'Guardian execution settlement receipt is unavailable':'Worker execution cleanup is pending; native execution may remain after an unconfirmed drain');
}
