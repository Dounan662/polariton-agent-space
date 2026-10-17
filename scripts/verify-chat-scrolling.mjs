import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
// Pass an explicitly installed Playwright module and browser binary; no application dependency or provider is required.
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]});
console.log('Browser',browser.version());
try {
for(const total of [2096,16000]) {
const page=await browser.newPage({viewport:{width:1000,height:800},reducedMotion:'reduce'});
const errors=[];page.on('pageerror',e=>errors.push(e.stack));page.on('console',m=>{if(m.type()==='error')errors.push(`${m.text()} (${m.location().url})`);});
const settle=()=>page.waitForTimeout(350);
const state=()=>page.evaluate(()=>{const e=document.querySelector('.history'),top=e.getBoundingClientRect().top;const rows=[...document.querySelectorAll('[data-chat-row]')];const anchor=rows.find(r=>r.getBoundingClientRect().bottom>top);return {mounted:rows.length,scroll:e.scrollTop,bottom:e.scrollHeight-e.scrollTop-e.clientHeight,requests:fixture.requests,sourceError:fixture.source.error,anchor:anchor&&{key:anchor.dataset.chatRow,offset:anchor.getBoundingClientRect().top-top}};});
await page.goto(`${process.env.POLARITON_CHAT_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/adr021/'}?events=${total}`);await page.waitForSelector('[data-chat-row]');await settle();
assert.equal(await page.getByRole('button',{name:'Jump to latest'}).count(),0);
console.log('initial',total,await state());assert.ok((await state()).bottom<=2);
// Hold a real older response to compare the visible anchor immediately before/after prepend.
await page.evaluate(()=>{fixture.hold=true;document.querySelector('.history').scrollTop=500;});
await page.waitForFunction(()=>fixture.gate);await settle();const before=await state();
await page.evaluate(()=>{fixture.hold=false;fixture.gate();fixture.gate=null;});await settle();const after=await state();
console.log('prepend',before,after);assert.equal(after.anchor.key,before.anchor.key);assert.ok(Math.abs(after.anchor.offset-before.anchor.offset)<=2);
const reading=after.anchor;await page.evaluate(()=>fixture.append());await settle();assert.deepEqual((await state()).anchor,reading);
// Native turn, process-group and tool disclosures retain independent state.
// The outer virtual row now owns a group rather than one generic tool <details>.
const turnHeader=page.locator('[data-turn-process][aria-expanded="false"]:not(:disabled)').first();
const turn=await turnHeader.getAttribute('data-turn-process');
await turnHeader.click();await settle();
const group=page.locator(`[data-step-process][data-chat-turn="${turn}"]`).first();
await group.locator('[data-process-activity]').click();await settle();
const toolHeader=group.locator('[data-chat-call-id] [data-disclosure-row]').first();
const callId=await toolHeader.evaluate(element=>element.closest('[data-chat-call-id]').getAttribute('data-chat-call-id'));
const toolKey=await toolHeader.evaluate(element=>element.closest('[data-chat-row]').getAttribute('data-chat-row'));
const rowSelector=`[data-chat-row=${JSON.stringify(toolKey)}]`;
const stableTool=page.locator(rowSelector).locator(`[data-chat-call-id=${JSON.stringify(callId)}] [data-disclosure-row]`);
await stableTool.click();await settle();assert.equal(await stableTool.getAttribute('aria-expanded'),'true');
const disclosurePosition=await state();
await stableTool.focus();await page.evaluate(()=>document.querySelector('.history').scrollTop=1e9);await settle();
assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-chat-row]')?.dataset.chatRow),toolKey);
assert.equal(await page.locator(rowSelector).count(),1);
await page.locator('.history').focus(); // release focus pin before moving away
await page.evaluate(scroll=>document.querySelector('.history').scrollTop=scroll,disclosurePosition.scroll);await settle();
await page.locator('.history').focus();await page.keyboard.press('End');await settle();assert.ok((await state()).bottom<=2);
await page.evaluate(()=>fixture.append());await settle();assert.ok((await state()).bottom<=2);
assert.equal(await page.locator(rowSelector).count(),0);
await page.evaluate(scroll=>document.querySelector('.history').scrollTop=scroll,disclosurePosition.scroll);await settle();
assert.equal(await stableTool.getAttribute('aria-expanded'),'true');
await page.evaluate(()=>{document.querySelector('.history').scrollTop=500;});await settle();
// Full replay establishes large-list DOM bounds.
const projectionMs=await page.evaluate(()=>{const start=performance.now();fixture.all();return performance.now()-start;});console.log('full projection ms',total,projectionMs);await settle();console.log('all loaded',await state());assert.ok((await state()).mounted<60);
await page.evaluate(()=>document.querySelector('.history').scrollTop=15000);await settle();const saved=await state();
await page.getByRole('button',{name:'Toggle mount'}).click();await settle();await page.getByRole('button',{name:'Toggle mount'}).click();await settle();const restored=await state();
console.log('restore',saved,restored);assert.equal(saved.anchor.key,restored.anchor.key);assert.ok(Math.abs(saved.anchor.offset-restored.anchor.offset)<=2);
// Inactive pane must not paginate, including a queued demand.
await page.getByRole('button',{name:'Toggle tab'}).click();const requests=(await state()).requests;await settle();assert.equal((await state()).requests,requests);
await page.getByRole('button',{name:'Toggle tab'}).click();await settle();
await page.getByRole('button',{name:'Local send navigation'}).click();await settle();console.log('local send tail',await state());assert.ok((await state()).bottom<=2);
await page.locator('.history').focus();const keyboardStart=await state();await page.keyboard.press('PageUp');await settle();assert.ok((await state()).scroll<keyboardStart.scroll);
await page.locator('.history').focus();await page.keyboard.press('End');await settle();
console.log('errors',errors);assert.deepEqual(errors,[]);

// A real image response arrives after its row is mounted; resize measurement keeps the tail.
let releaseImage;const imageGate=new Promise(resolve=>{releaseImage=resolve;});
await page.route('**/image?*',async route=>{await imageGate;await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="teal"/></svg>'});});
await page.evaluate(()=>fixture.image());await settle();releaseImage();await settle();assert.ok((await state()).bottom<=2);
// Streaming expands the existing last row, but never steals an older reading position.
await page.evaluate(()=>fixture.stream('Streaming begins.\n\n'));await settle();
await page.evaluate(()=>fixture.stream('More streamed output.\n\n'.repeat(60)));await settle();assert.ok((await state()).bottom<=2);
await page.evaluate(()=>document.querySelector('.history').scrollTop-=2000);await settle();const during=await state();
await page.evaluate(()=>fixture.stream('Incoming output while reading history.\n\n'.repeat(40)));await settle();assert.deepEqual((await state()).anchor,during.anchor);
await page.setViewportSize({width:850,height:700});await settle();const resized=await state();assert.equal(resized.anchor.key,during.anchor.key);assert.ok(Math.abs(resized.anchor.offset-during.anchor.offset)<=2);
// Text selection keeps the selected mounted row alive during navigation.
const selected=await page.evaluate(()=>{const e=document.querySelector('.history'),row=[...document.querySelectorAll('[data-chat-row]')].find(r=>r.getBoundingClientRect().bottom>e.getBoundingClientRect().top);const range=document.createRange();range.selectNodeContents(row);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return {key:row.dataset.chatRow,text:selection.toString()};});
await settle();await page.evaluate(()=>document.querySelector('.history').scrollTop=12000);await settle();
assert.equal(await page.evaluate(()=>getSelection().toString()),selected.text);
assert.equal(await page.locator(`[data-chat-row=${JSON.stringify(selected.key)}]`).count(),1);
await page.evaluate(()=>getSelection().removeAllRanges());await settle();
// Warm scrolling profile: two CSS pixels for anchor tolerance, fewer than 60
// mounted rows, and p95 frame interval below 50 ms on this explicit desktop profile.
const frames=await page.evaluate(()=>new Promise(resolve=>{
 const samples=[];let previous=performance.now();
 const frame=now=>{samples.push(now-previous);previous=now;document.querySelector('.history').scrollTop+=20;if(samples.length<60)requestAnimationFrame(frame);else resolve(samples.sort((a,b)=>a-b));};requestAnimationFrame(frame);
}));
const p95=frames[Math.floor(frames.length*.95)];console.log('warm frames ms',total,{p95,max:frames.at(-1)});assert.ok(p95<50);

console.log('streamed',total,await state());assert.ok((await state()).mounted<60);
assert.deepEqual(errors,[]);await page.close();
}
// A failed automatic request stays stopped until the reader explicitly retries.
const recoveryContext=await browser.newContext({viewport:{width:1000,height:800}});
const page=await recoveryContext.newPage();
await page.goto(`${process.env.POLARITON_CHAT_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/adr021/'}?events=2096`);
await page.waitForSelector('[data-chat-row]');await page.waitForTimeout(350);
await page.evaluate(()=>{fixture.fail=true;document.querySelector('.history').scrollTop=500;});
await page.getByRole('button',{name:'Continue loading'}).waitFor();const failed=await page.evaluate(()=>fixture.requests);
await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>fixture.requests),failed);
await page.evaluate(()=>fixture.fail=false);await page.getByRole('button',{name:'Continue loading'}).click();await page.waitForTimeout(350);
assert.equal(await page.evaluate(()=>fixture.source.error),'');assert.equal(await page.evaluate(()=>fixture.maxInFlight),1);
console.log('explicit read recovery passed');
// Cold restoration finds a bookmark outside the initial page without a click.
// Close the previous reader before seeding the next page: its visibility and
// delayed persistence otherwise race a synthetic bookmark in shared storage.
await page.close();
const restoredPage=await recoveryContext.newPage();
await restoredPage.addInitScript(()=>localStorage.setItem('polariton.reading.adr021',JSON.stringify({key:'13:input-messageuser-1906',offset:-20,atBottom:false})));
await restoredPage.goto(`${process.env.POLARITON_CHAT_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/adr021/'}?events=2096`);
await restoredPage.waitForSelector('[data-chat-row="13:input-messageuser-1906"]');await restoredPage.waitForTimeout(350);
const restoreResult=await restoredPage.evaluate(()=>{const host=document.querySelector('.history'),row=document.querySelector('[data-chat-row="13:input-messageuser-1906"]');return {offset:row.getBoundingClientRect().top-host.getBoundingClientRect().top,requests:fixture.requests};});
console.log('cold restore',restoreResult);assert.ok(Math.abs(restoreResult.offset+20)<=2);assert.ok(restoreResult.requests>=1);
await restoredPage.close();
const cancelled=await recoveryContext.newPage();
await cancelled.addInitScript(()=>localStorage.setItem('polariton.reading.adr021',JSON.stringify({key:'13:input-messageuser-10',offset:-20,atBottom:false})));
await cancelled.goto(`${process.env.POLARITON_CHAT_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/adr021/'}?events=2096&hold=1`);
await cancelled.waitForFunction(()=>fixture.gate);await cancelled.locator('.history').focus();await cancelled.keyboard.press('End');await cancelled.waitForTimeout(350);
await cancelled.evaluate(()=>{fixture.hold=false;fixture.gate();fixture.gate=null;});await cancelled.waitForTimeout(500);
assert.equal(await cancelled.evaluate(()=>fixture.requests),1);
assert.equal(await cancelled.locator('[data-chat-row="13:input-messageuser-10"]').count(),0);
console.log('user navigation cancels pending cold restoration');await recoveryContext.close();

}finally{await browser.close();}
