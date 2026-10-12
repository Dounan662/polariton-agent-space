import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {ShellEnvRegistry} from '@deepseek-ai/dsh-shell-env';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';

/** Exercise the actual DSH environment boundary; ambient credentials are not grants. */
test('DSH shell registry grants survive subprocess scrubbing while ambient credentials do not', {timeout: 15000}, async t => {
  const ctx = new Context(), names = ['HARNESSCTL_TOKEN', 'DSH_HARNESSCTL_TOKEN'];
  const prior = names.map(name => process.env[name]);
  t.after(async () => {
    await ctx.fiber.dispose();
    names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; });
  });
  process.env.HARNESSCTL_TOKEN = 'synthetic-private-ambient';
  process.env.DSH_HARNESSCTL_TOKEN = 'synthetic-forged-ambient';
  await ctx.plugin(ShellEnvRegistry, {dshHome: process.cwd()});
  await ctx.plugin(LocalSubprocessRuntime);
  const dispose = ctx.shellEnv.register({name: 'qualification-caller', variables: {DSH_HARNESSCTL_TOKEN: {description: 'Synthetic caller grant'}}, resolve: () => ({DSH_HARNESSCTL_TOKEN: 'synthetic-explicit-grant'})});
  async function childEnvironment(env) {
    const child = ctx.subprocess.spawn({argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ambient:process.env.HARNESSCTL_TOKEN,granted:process.env.DSH_HARNESSCTL_TOKEN,shell:process.env.DSH_SHELL}))'], cwd: process.cwd(), env, graceMs: 1000, stdio: {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'}});
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.resume();
    assert.equal((await child.done).exitCode, 0); return JSON.parse(output);
  }
  assert.deepEqual(await childEnvironment({}), {});
  assert.deepEqual(await childEnvironment(ctx.shellEnv.collect({})), {granted: 'synthetic-explicit-grant', shell: '1'});
  assert(!JSON.stringify(ctx.shellEnv.list()).includes('synthetic-explicit-grant'), 'Discovery reveals declarations without credential values');
  dispose();
  assert.deepEqual(await childEnvironment(ctx.shellEnv.collect({})), {shell: '1'});
});
