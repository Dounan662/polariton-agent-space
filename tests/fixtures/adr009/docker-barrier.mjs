import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// A child-only PATH wrapper holds the real Docker response at the crash window.
// The running container is untouched; releasing the barrier also reaps the wrapper.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const args = process.argv.slice(3);
// Backend container reads end in `inspect <id>`; context/image metadata must
// pass through unchanged, including formatted scalar JSON responses.
const inspecting = args.at(-2) === 'inspect' && /^[a-f0-9]{12,64}$/.test(args.at(-1) ?? '');
const child = spawn(config.executable, args, { stdio: ['inherit', inspecting ? 'pipe' : 'inherit', 'inherit'] });
const chunks = []; let size = 0;
if (inspecting) child.stdout.on('data', chunk => {
  size += chunk.length;
  if (size > config.maxBytes) child.kill('SIGKILL'); else chunks.push(chunk);
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', async code => {
  if (code !== 0) { process.exitCode = code ?? 1; return; }
  if (!inspecting) return;
  const output = Buffer.concat(chunks);
  const values = JSON.parse(output.toString());
  const target = values.find(value => value.Config?.Labels?.['polariton.mount'] === config.mountId && value.State?.Running);
  if (target) {
    const marker = { containerId: target.Id, generation: target.Config.Labels['polariton.generation'], mountId: config.mountId };
    const temporary = `${config.reached}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(marker)); await rename(temporary, config.reached);
    const deadline = Date.now() + config.waitMs;
    while (true) {
      try { await access(config.release); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) { console.error('Docker test barrier timed out'); process.exitCode = 1; return; }
      await delay(config.pollMs);
    }
  }
  process.stdout.on('error', error => { if (error.code !== 'EPIPE') throw error; });
  process.stdout.end(output);
});
