// @ts-check
export const inject=['systemPrompt'];

/** The launch owner supplies immutable worker instructions. Literal text cannot become
 * a DSH template, and the section augments the harness's operating instructions. */
/** @param {import('@deepseek-ai/cordis').Context} ctx @param {{placement?:string,text?:string}} config */
export function apply(ctx,config){
 if(config?.placement!==undefined){
  if(typeof config.placement!=='string')throw new Error('Worker placement must be supplied text');
  ctx.systemPrompt.section({name:'polariton:placement',order:10300,text:config.placement,interpolate:false});
 }
 if(config?.text!==undefined){
  if(typeof config.text!=='string')throw new Error('Worker instructions must be captured text');
  ctx.systemPrompt.section({name:'polariton:worker-instructions',order:10310,text:config.text,interpolate:false});
 }
}
