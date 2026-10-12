import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
process.once('message', config => {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../../../harness/guardian.mjs',import.meta.url))],{detached:true,stdio:['pipe','pipe','pipe','pipe','ipc']});
  child.stdout.resume();child.stderr.resume();child.stdio[3].resume();
  child.on('message',message=>process.send?.({...message,guardianPid:child.pid}));
  child.on('error',()=>process.exit(1));
  child.send(config);
});
