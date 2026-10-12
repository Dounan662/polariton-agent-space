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
function result(overrides:Partial<ToolResultNode>={}):ToolResultNode{return {kind:'tool-result',seq:4,time:400,callId:'call-1',call:{name:'bash',argsRaw:JSON.stringify({command:'ls',description:'List files'})},callTime:300,content:[{type:'text',text:'file.txt'}],isError:false,subCalls:[],...overrides}}

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
 const model=toolRowModel('bash',{phase:'preparing',callId:'pending',name:'bash',turn:1,step:1,time:100,subCalls:[]})
 assert.equal(model.state,'preparing')
 assert.equal(model.bodyRaw,null)
 assert.equal(model.output,null)
})
