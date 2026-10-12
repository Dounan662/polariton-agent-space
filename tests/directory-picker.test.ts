import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DirectoryPicker} from '../src/directory-picker.ts';

const waitForAbort = (signal: AbortSignal): Promise<null> => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), {once:true});
});
test('native picker cancellation is a normal result; selected paths are unchanged', async () => {
  const signal = new AbortController().signal;
  const picker = new DirectoryPicker({timeoutMs:1000,maxOutputBytes:1048576}, async () => null);
  assert.equal(await picker.choose(signal), null);
  assert.equal(await new DirectoryPicker({timeoutMs:1000,maxOutputBytes:1048576}, async () => '/a repository').choose(signal), '/a repository');
});
test('native picker bounds overlapping requests, disconnect, deadline and shutdown', async () => {
  const controller = new AbortController(), picker = new DirectoryPicker({timeoutMs:1000,maxOutputBytes:1048576}, waitForAbort);
  const first = picker.choose(controller.signal);
  await assert.rejects(picker.choose(controller.signal), /already open/);
  controller.abort(new Error('disconnected'));
  await assert.rejects(first, /disconnected/);
  const next = picker.choose(new AbortController().signal);
  picker.close(); await assert.rejects(next, /shutting down/);
  await assert.rejects(picker.choose(new AbortController().signal), /shutting down/);
  const timed = new DirectoryPicker({timeoutMs:5,maxOutputBytes:1048576}, waitForAbort);
  await assert.rejects(timed.choose(new AbortController().signal), /timed out/);
  await assert.rejects(timed.choose(new AbortController().signal), /timed out/);
});
test('native picker reports helper failure and accepts a later selection', async () => {
  let fail = true;
  const picker = new DirectoryPicker({timeoutMs:1000,maxOutputBytes:1048576}, async () => {if(fail)throw new Error('helper unavailable'); return '/repo';});
  await assert.rejects(picker.choose(new AbortController().signal), /helper unavailable/);
  fail = false; assert.equal(await picker.choose(new AbortController().signal), '/repo');
});
