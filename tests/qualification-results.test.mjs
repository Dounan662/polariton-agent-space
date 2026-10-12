import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolFailure} from '../scripts/qualification-results.mjs';

const observation=(text,isError=false,name='bash')=>({name,result:{isError,content:[{type:'text',text}]}});
test('qualification catches command exits independently of DSH tool execution errors',()=>{
 assert.equal(toolFailure(observation('help output\n[exit code: 2]')), 'bash-exit:2');
 assert.equal(toolFailure(observation('[exit code: 7]\n')), 'bash-exit:7');
 assert.equal(toolFailure(observation('spawn failed',true)), 'tool-error');
 assert.equal(toolFailure(observation('normal output')),null);
 assert.equal(toolFailure(observation('normal output\n[exit code: 0]')),null);
 assert.equal(toolFailure(observation('Example: [exit code: 2]\nnormal output')),null);
 assert.equal(toolFailure(observation('[exit code: 2]',false,'read')),null);
});
test('qualification does not count interrupted or ongoing Bash execution as successful completion',()=>{
 for(const text of ['output\n[killed by signal: SIGTERM]','output\n[timed out after 100ms]\n[exit code: 0]','output\n[stopped: cancelled]'])assert.equal(toolFailure(observation(text)),'bash-interrupted');
 assert.equal(toolFailure(observation('output\n[still running after 100ms; moved to background job abc]\nThe command keeps running.')),'bash-incomplete');
});
