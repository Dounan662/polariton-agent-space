import {randomUUID} from 'node:crypto';
import type {AgentManager} from '../../src/agents.ts';
import type {Submission} from '../../src/contracts.ts';

export const activationText='Fixture activation: complete this setup turn immediately.';
/** Historical control tests require an already-bound worker. Activate through
 * its first public prompt; only this named fixture turn settles automatically.
 */
export function isActivationPrompt(params:unknown):boolean {
  const prompt=(params as {content?:Array<{type:string;text?:string}>})?.content;
  return prompt?.length===1&&prompt[0]?.type==='text'&&prompt[0].text===activationText;
}
/** Assertions about the exercised turns explicitly exclude the named setup turn. */
export const isExerciseSubmission=(value:Submission)=>value.text!==activationText;
export async function awaitSubmission(agents:AgentManager,project:string,node:string,workerId:string,id:string){
  await new Promise<void>((resolve,reject)=>{
    const changed=()=>{
      const receipt=agents.list(project,node).find(value=>value.id===workerId)?.submissions.find(value=>value.id===id);
      if(!receipt||['pending','admitted'].includes(receipt.state))return;
      agents.off('change',changed);
      if(receipt.state==='applied')resolve();else reject(new Error(receipt.detail??receipt.state));
    };
    agents.on('change',changed);changed();
  });
}
export async function activateWorker(agents:AgentManager,project:string,node:string,workerId:string){
  if(agents.list(project,node).find(value=>value.id===workerId)?.harnessSessionId){await agents.resume(project,node,workerId);return;}
  const id=randomUUID();await agents.submit(project,node,workerId,{id,text:activationText});
  await awaitSubmission(agents,project,node,workerId,id);
}
