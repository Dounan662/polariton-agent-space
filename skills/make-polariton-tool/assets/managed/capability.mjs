import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Own the scientific operation here. Configuration is fixed per mounted release;
 * each MCP connection gets its own protocol server, not another copy of domain state. */
export function createCapability(rawConfiguration) {
  const {scale}=z.object({scale:z.number().finite()}).strict().parse(rawConfiguration);
  const server=new McpServer({name:'domain-capability',version:'1.0.0'});
  server.registerTool('scale_values',{
    description:'Multiply each finite input value by the configured scale; return the complete result.',
    inputSchema:z.object({values:z.array(z.number().finite()).min(1).max(100)}),
  },async({values})=>{
    const scaled=values.map(value=>value*scale);
    if(scaled.some(value=>!Number.isFinite(value)))return {isError:true,content:[{type:'text',text:'Result exceeds finite numeric range; reduce the input magnitude.'}]};
    const result={scale,values:scaled};
    return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  });
  server.registerResource('version','capability://version',{mimeType:'application/json'},async()=>({
    contents:[{uri:'capability://version',mimeType:'application/json',text:JSON.stringify({version:'1.0.0',tools:['scale_values']})}],
  }));
  return server;
}
