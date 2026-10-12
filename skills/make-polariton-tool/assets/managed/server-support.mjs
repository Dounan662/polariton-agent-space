import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

/** Host an MCP capability with binding-scoped authorization. The rack owns the read-only
 * grant file; sessions never confer authority independently of a currently valid grant.
 * Tool code owns its outcomes. Closing an HTTP stream is not evidence of cancellation.
 */
export async function serveCapability({createServer:makeServer,port=Number(process.env.PORT??8080),host='0.0.0.0',maxBodyBytes=Number(process.env.POLARITON_MAX_BODY_BYTES??1048576),maxSessions=Number(process.env.POLARITON_MAX_BINDINGS??64),onRequest}) {
  const sessions=new Map();
  const server=createServer(async(req,res)=>{
    try {
      if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({available:true}));return;}
      if(req.url!=='/mcp'){if(await onRequest?.(req,res))return;res.writeHead(404);res.end();return;}
      if(req.headers.origin){res.writeHead(403);res.end('Browser origins are not authorized');return;}
      const hostName=(req.headers.host??'').split(':')[0];
      if(!['127.0.0.1','localhost'].includes(hostName)){res.writeHead(403);res.end('Invalid host');return;}
      const token=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
      let authority;
      try{authority=JSON.parse(await readFile(process.env.POLARITON_AUTH_FILE,'utf8'));}
      catch(error){throw new Error(`Cannot read binding authority: ${error.message}`);}
      const hash=token&&createHash('sha256').update(token).digest('hex');
      const grant=authority.bindings.find(value=>value.hash===hash);
      if(!grant){res.writeHead(401);res.end('Invalid or released connection');return;}
      let body;
      if(req.method==='POST'){
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>maxBodyBytes){res.writeHead(413);res.end();return;}chunks.push(chunk);}
        body=Buffer.concat(chunks).toString('utf8');
        const message=JSON.parse(body);
        if(Array.isArray(message)){res.writeHead(400);res.end('Batch requests are unsupported');return;}
        const observationMethods=new Set(['server/discover','initialize','notifications/initialized','ping','tools/list','resources/list','resources/templates/list','resources/read','notifications/cancelled']);
        if(grant.access==='observe'&&!observationMethods.has(message.method)){res.writeHead(403);res.end('Observation grant cannot invoke actions');return;}
      }
      const sessionId=req.headers['mcp-session-id'];
      let session=sessionId&&sessions.get(sessionId);
      if(sessionId&&(!session||session.binding!==grant.id||session.generation!==authority.generation)){res.writeHead(session?403:404);res.end('Session does not belong to this binding');return;}
      if(!session){
        if(req.method!=='POST'||!['initialize','server/discover'].includes(JSON.parse(body).method)){res.writeHead(400);res.end('Initialize first');return;}
        // Released bindings cannot retain unbounded idle sessions.
        for(const [id,value] of sessions)if(!authority.bindings.some(b=>b.id===value.binding)||value.generation!==authority.generation){await value.transport.close();sessions.delete(id);}
        if(sessions.size>=maxSessions){res.writeHead(429);res.end('Session capacity reached');return;}
        const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true,onsessioninitialized:id=>sessions.set(id,session),onsessionclosed:id=>sessions.delete(id)});
        const mcp=makeServer();session={transport,mcp,binding:grant.id,generation:authority.generation};
        await mcp.connect(transport);
      }
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      const response=await session.transport.handleRequest(new Request(`http://${req.headers.host}/mcp`,{method:req.method,headers,...(body!==undefined?{body}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(chunk))await once(res,'drain');}
      res.end();
    }catch(error){console.error(JSON.stringify({event:'mcp.request.failed',error:String(error)}));if(!res.headersSent)res.writeHead(500);res.end('Capability request failed');}
  });
  server.on('close',()=>{for(const value of sessions.values())void value.mcp.close().catch(error=>console.error(String(error)));sessions.clear();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return server;
}
