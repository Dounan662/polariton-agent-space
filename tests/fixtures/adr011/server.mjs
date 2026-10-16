import {createServer} from 'node:http';
import {appendFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {McpServer,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';

/** Independent receipts prove connection, discovery and exact tool execution. They
 * never contain incoming authorization or environment values. This fixture owns
 * no research data, login state, external application or daemonized processes. */
export function recorder(path){return value=>{if(path)appendFileSync(path,JSON.stringify({fixture:'adr011',pid:process.pid,...value})+'\n',{mode:0o600});};}
/** @param {{record?:(entry:Record<string,any>)=>void,version?:number}} [options] */
export function capability({record=()=>{},version=1}={}){
  const server=new McpServer({name:'adr011-controlled',version:String(version)});
  server.registerTool('transform',{description:'Compute value * 7 + version. Return the exact receipt and result.',inputSchema:z.object({value:z.number(),label:z.string().max(96)})},async input=>{
    const output={value:input.value*7+version,label:input.label,version,receipt:randomUUID()};
    record({phase:'invoked',tool:'transform',input,output});
    return {content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};
  });
  return server;
}
/** @param {{record?:(entry:Record<string,any>)=>void,token?:string|(()=>string),port?:number,version?:number,beforeRequest?:(message:any)=>Promise<void>}} [options] */
export async function serveHttp({record=()=>{},token,port=0,version=1,beforeRequest=async()=>{}}={}){
  const sessions=new Set();
  const server=createServer(async(req,res)=>{
    try{
      if(req.url==='/health'){res.writeHead(200).end('{}');return;}
      if(req.url!=='/mcp'){res.writeHead(404).end();return;}
      const expectedToken=typeof token==='function'?token():token;
      if(expectedToken&&req.headers.authorization!==`Bearer ${expectedToken}`){record({phase:'denied'});res.writeHead(401).end();return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=Buffer.concat(chunks).toString(),message=body?JSON.parse(body):null;
      record({phase:'request',method:message?.method??req.method});
      await beforeRequest(message);
      const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
      const mcp=capability({record,version});sessions.add(mcp);await mcp.connect(transport);
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      const response=await transport.handleRequest(new Request(`http://${req.headers.host}/mcp`,{method:req.method,headers,...(body?{body}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)for await(const chunk of response.body)res.write(chunk);
      res.end();await mcp.close();sessions.delete(mcp);
    }catch{record({phase:'failed'});if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();
  return {url:`http://127.0.0.1:${address.port}/mcp`,async close(){for(const mcp of sessions)await mcp.close();await new Promise(resolve=>server.close(resolve));}};
}
export async function serveStdio({record=()=>{},version=1,application,requireInitialize=false}={}){
  if(application)readFileSync(application);
  const server=capability({record,version}),transport=new StdioServerTransport();
  await server.connect(transport);
  const receive=transport.onmessage;
  transport.onmessage=(message,extra)=>{record({phase:'request',method:message.method??'response'});if(requireInitialize&&message.method==='server/discover')process.exit(1);receive(message,extra);};
  record({phase:'launched',cwd:process.cwd()});
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const record=recorder(process.env.ADR011_RECEIPTS),version=Number(process.env.ADR011_VERSION??1);
  if(process.argv[2]==='http'){
    const service=await serveHttp({record,version,token:process.env.ADR011_TOKEN,port:Number(process.env.PORT??0)});
    process.stdout.write(JSON.stringify({url:service.url})+'\n');
    process.once('SIGTERM',()=>{void service.close();});
  }else await serveStdio({record,version,application:process.env.ADR011_APPLICATION,requireInitialize:process.env.ADR011_REQUIRE_INITIALIZE==='1'});
}
