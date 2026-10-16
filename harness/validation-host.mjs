import {Socket} from 'node:net';
import {z} from 'zod';
import {validateMcp} from './mcp-validation-host.ts';
import {McpValidationInput,McpValidationLimits} from './mcp-contracts.ts';

// This execution host mounts only ToolRuntime and the production MCP adapter.
// Its private drain channel must confirm cleanup before the guardian retires it.
const control=new Socket({fd:4}),bridge=new Socket({fd:3}),abort=new AbortController();
const maxBytes=z.coerce.number().int().positive().parse(process.env.POLARITON_MAX_FRAME_BYTES);
let work,received=false,draining=false;
function frames(socket,consume){let buffer=Buffer.alloc(0);socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>maxBytes){socket.destroy();return;}let end;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);try{consume(JSON.parse(line.toString('utf8')));}catch{socket.destroy();}}});socket.on('error',()=>abort.abort());}
frames(bridge,raw=>{
  if(raw?.kind==='cancel'){abort.abort();return;}
  if(received||draining)throw new Error('Validation already started');received=true;
  const input=McpValidationInput.parse(raw.input),limits=McpValidationLimits.parse(raw.limits);
  work=validateMcp(input,limits,abort.signal);
  void work.then(result=>bridge.write(JSON.stringify({result})+'\n'),()=>bridge.write(JSON.stringify({error:'MCP_VALIDATION_FAILED'})+'\n'));
});
frames(control,raw=>{
  const message=z.object({id:z.string(),method:z.literal('drain')}).strict().parse(raw);draining=true;abort.abort();
  void Promise.resolve(work).then(result=>{control.write(JSON.stringify({id:message.id,settled:result?.cleanup.status==='settled'||!received})+'\n');},()=>control.write(JSON.stringify({id:message.id,settled:false})+'\n'));
});
bridge.on('close',()=>abort.abort());control.on('close',()=>abort.abort());
