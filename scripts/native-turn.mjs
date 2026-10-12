import {randomUUID} from 'node:crypto';

/** Wait for the identified input's terminal execution, independently of admission. */
export function nativeTurn(harness,sessionId,text,timeoutMs) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw new Error('Verification turn requires an explicit positive deadline');
  const requestId=randomUUID(),completion=Promise.withResolvers();let turnId;
  const turn=value=>{
    if(value.sessionId!==sessionId)return;
    if(value.phase==='claimed'&&value.requestId===requestId)turnId=value.id;
    if(value.phase==='ended'&&value.id===turnId)completion.resolve({reason:value.reason});
  };
  const submission=value=>{if(value.sessionId===sessionId&&value.requestId===requestId&&value.state==='interrupted')completion.reject(new Error('Verification input was discarded before completion'));};
  const failed=error=>completion.reject(error);
  harness.on('turn',turn);harness.on('submission',submission);harness.on('transportError',failed);
  const timer=setTimeout(()=>completion.reject(new Error('Verification turn did not finish within its request budget')),timeoutMs);
  const admission=harness.message(sessionId,requestId,[{type:'text',text}],{kind:'human'});
  return Promise.all([admission,completion.promise]).then(([,ended])=>ended)
    .finally(()=>{clearTimeout(timer);harness.off('turn',turn);harness.off('submission',submission);harness.off('transportError',failed);});
}
