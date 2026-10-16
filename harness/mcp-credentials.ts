import {request} from 'node:http';
import {z} from 'zod';
import {McpCredentialHandle} from './mcp-contracts.ts';

/** Resolve current authority immediately before a request. The Environment owner
 * serializes refresh and checks disconnect; transport failures never replay calls. */
export function credentialProvider(input:McpCredentialHandle,limits:{timeoutMs:number;maxBytes:number}) {
  const handle=McpCredentialHandle.parse(input);
  return {token:(signal?:AbortSignal):Promise<string>=>new Promise((resolve,reject)=>{
    const failure=()=>Object.assign(new Error('MCP credential authority is unavailable'),{code:'MCP_CREDENTIAL_UNAVAILABLE'});
    if(signal?.aborted){reject(failure());return;}
    const body=JSON.stringify({accessId:handle.accessId,serverName:handle.serverName});
    const pending=request({socketPath:handle.socketPath,path:'/v1/access/credential',method:'POST',signal,headers:{authorization:`Bearer ${handle.token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{
      let bytes=0;const chunks:Buffer[]=[];
      response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limits.maxBytes){pending.destroy(failure());return;}chunks.push(chunk);});
      response.on('error',()=>reject(failure()));
      response.on('end',()=>{
        clearTimeout(timer);
        try {if(response.statusCode!==200)throw failure();const value=z.object({accessToken:z.string().min(1)}).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));resolve(value.accessToken);}catch{reject(failure());}
      });
    });
    const timer=setTimeout(()=>pending.destroy(failure()),limits.timeoutMs);
    pending.on('error',()=>{clearTimeout(timer);reject(failure());});
    pending.end(body);
  })};
}
