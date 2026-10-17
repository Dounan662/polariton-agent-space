import {terminalCardModel,terminalFailed,terminalExitLabel} from '../web/src/native/client/ui-tool/src/client/tool/models/terminal-card-model.ts'
import {en,translate} from '../web/src/native/client/ui-tool/src/client/locales.ts'
import {PartialArguments} from '@deepseek-ai/dsh-util-values'
import assert from 'node:assert/strict'
import test from 'node:test'
import {ScrollFollow,scrollMetrics} from '../web/src/native/client/ui-chat/src/client/chat/use-scroll-follow.ts'
import {toolRowModel} from '../web/src/native/client/ui-tool/src/client/tool/models/tool-call-model.ts'
import type {ToolResultNode} from '../web/src/native/conversation.ts'

function scrollport(){
 const requests:ScrollToOptions[]=[]
 const surface={scrollTop:0,clientHeight:100,scrollHeight:500,scrollTo(value:ScrollToOptions){requests.push(value);if(value.behavior==='instant')surface.scrollTop=value.top??surface.scrollTop}}
 return {element:surface as unknown as HTMLElement,surface,requests}
}
function result(overrides:Partial<ToolResultNode>={}):ToolResultNode{const block={kind:'tool-result',seq:4,time:400,callId:'call-1',call:{name:'bash',argsRaw:JSON.stringify({command:'ls',description:'List files'})},callTime:300,content:[{type:'text' as const,text:'file.txt'}],isError:false,subCalls:[],...overrides};return {...block,kind:'tool-result',name:block.call?.name??'',args:PartialArguments.fromText(block.call?.argsRaw??'')}}

test('nested process scrolling follows growth until actual reader movement interrupts it',()=>{
 const {element,surface,requests}=scrollport(),follow=new ScrollFollow(false,1)
 follow.jump(element,scrollMetrics(element),400)
 assert.equal(follow.active,true)
 surface.scrollHeight=600
 follow.toBottom(element,scrollMetrics(element),'smooth')
 assert.equal(follow.animating,true)
 assert.equal(requests.at(-1)?.top,500)
 surface.scrollTop=450
 follow.sample(scrollMetrics(element))
 assert.equal(follow.active,true,'native animation does not become reader intent')
 follow.interrupt(element,scrollMetrics(element))
 surface.scrollTop=300
 follow.sample(scrollMetrics(element))
 assert.equal(follow.active,false,'a reader leaving the tail stops following')
 assert.equal(follow.animating,false)
})

test('restoring a nested reading position clamps offsets without claiming follow intent',()=>{
 const {element,surface}=scrollport(),follow=new ScrollFollow(false,1)
 follow.jump(element,scrollMetrics(element),200)
 follow.setFollowing(false)
 assert.equal(surface.scrollTop,200)
 assert.equal(follow.active,false)
 surface.scrollHeight=180
 follow.jump(element,scrollMetrics(element),200)
 follow.setFollowing(false)
 assert.equal(surface.scrollTop,80)
 assert.equal(follow.active,false)
})

test('native tool presentation retains original input and complete successful output',()=>{
 const block=result(),model=toolRowModel('bash',block)
 assert.equal(model.state,'ok')
 assert.equal(model.variant,'bash')
 assert.equal(model.summary,'List files')
 assert.equal(model.bodyRaw,block.call?.argsRaw)
 assert.equal(model.output,'file.txt')
})

test('native tool presentation distinguishes terminal failure, interruption, and missing history',()=>{
 const failed=toolRowModel('bash',result({isError:true,content:[{type:'text',text:'Permission denied\nDetails retained'}]}))
 assert.equal(failed.state,'error')
 assert.equal(failed.errorSummary,'Permission denied')
 assert.equal(failed.output,'Permission denied\nDetails retained')
 const interrupted=toolRowModel('bash',result({isError:true,error:{name:'AbortError',code:'interrupted'}}))
 assert.equal(interrupted.state,'stopped')
 const partial=toolRowModel('',result({call:null}))
 assert.equal(partial.summary,'call-1')
 assert.equal(partial.bodyRaw,null)
 assert.equal(partial.output,'file.txt')
})

test('preparing tool rows do not fabricate arguments or results',()=>{
 const model=toolRowModel('bash',{phase:'preparing',callId:'pending',name:'bash',args:PartialArguments.EMPTY,turn:1,step:1,time:100,subCalls:[]})
 assert.equal(model.state,'preparing')
 assert.equal(model.bodyRaw,null)
 assert.equal(model.output,null)
})

test('tool preparation shows partial descriptions but opens only recorded successful paths',()=>{
 const args=PartialArguments.fromText('{"description":"Checking work');
 const preparing={phase:'preparing' as const,callId:'pending',name:'bash',args,turn:1,step:1,time:100,subCalls:[]};
 assert.equal(toolRowModel('bash',preparing).summary,'Checking work');
 assert.equal(toolRowModel('bash',preparing).bodyRaw,null);
 const call={name:'read',argsRaw:'{"file_path":"plot.txt"}'};
 assert.equal(toolRowModel('read',result({call,meta:{path:'/actual/work/plot.txt'}}),'/old/work').filePath,'/actual/work/plot.txt');
 assert.equal(toolRowModel('read',result({call,isError:true}),'/old/work').filePath,undefined);
});


test('terminal cards preserve recorded cwd, unknown exits, and background acknowledgements',()=>{
 const failed=terminalCardModel(result({meta:{cwd:'/actual/work'},content:[{type:'text',text:'partial output\n[exit code: null]'}]}),'/former/work');
 assert.ok(failed);assert.equal(failed.card.cwd,'/actual/work');assert.equal(failed.card.exitCode,null);
 assert.equal(terminalFailed(failed),true);
 assert.equal(terminalExitLabel(failed,translate),en['terminal.noExitCode']);
 const background=terminalCardModel(result({call:{name:'bash',argsRaw:JSON.stringify({command:'sleep 10',description:'Start job',run_in_background:true})},content:[{type:'text',text:'Started job abc'}]}));
 assert.ok(background);assert.equal(background.card.background,true);assert.equal(background.card.output,undefined);
 assert.equal(terminalExitLabel(background,translate),null);
});
