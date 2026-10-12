import { spawn } from 'node:child_process';
import { existsSync, openSync, writeSync, writeFileSync } from 'node:fs';

// Destructive workload is deliberately unreachable on an ordinary host process.
if (process.env.POLARITON_FIXTURE_DESTRUCTIVE !== '1' || !existsSync('/.dockerenv')) throw new Error('Destructive fixture requires an explicitly enabled container');
const mode = process.argv[2];
if (mode === 'cpu') while (true) Math.sqrt(Math.random());
else if (mode === 'memory') {
  writeFileSync('/proc/self/oom_score_adj', '1000');
  const retained = [];
  setInterval(() => retained.push(Buffer.alloc(8 * 1024 * 1024, 1)), 10);
} else if (mode === 'output') {
  const block = Buffer.alloc(65536, 120);
  block[block.length - 1] = 10;
  let bytes = 0;
  const write = () => {
    let flowing;
    do { flowing = process.stdout.write(block); bytes += block.length; if (bytes % (1024 * 1024) === 0) process.send?.({ bytes }); } while (flowing);
    process.stdout.once('drain', write);
  };
  write();
} else if (mode === 'disk') {
  const fd = openSync('/state/exhaustion.dat', 'w');
  const block = Buffer.alloc(1024 * 1024, 1);
  while (true) writeSync(fd, block);
} else if (mode === 'helpers') {
  setInterval(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }).on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(1); }), 20);
} else throw new Error('Unknown destructive fixture mode');
