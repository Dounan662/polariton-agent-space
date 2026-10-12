import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
// Same external browser tooling and source-only fixture as verify-chat-scrolling.
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]});
try {
 for(const total of [2096,16000]) {
  const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
   const Native=window.ResizeObserver;
   window.measurementProbe={enabled:false,shifts:[]};
   // Check the DOM immediately after resize delivery, before it can paint.
   // Sampling only settled frames misses a scroll write followed by a later
   // React commit that repairs positions. This observes public DOM geometry.
   window.ResizeObserver=class extends Native {
    constructor(callback){super((entries,observer)=>{
     const probe=window.measurementProbe;
     if(!probe.enabled){callback(entries,observer);return;}
     const host=document.querySelector('.history'),top=host?.getBoundingClientRect().top;
     const row=host&&[...host.querySelectorAll('[data-chat-row]')].find(row=>row.getBoundingClientRect().bottom>top+1);
     const before=row?.getBoundingClientRect().top;
     callback(entries,observer);
     if(row?.isConnected){const delta=row.getBoundingClientRect().top-before;if(Math.abs(delta)>2)probe.shifts.push({key:row.dataset.chatRow,delta});}
    });}
   };
  });
  await page.goto(`${process.env.POLARITON_CHAT_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/adr021/'}?events=${total}`);
  await page.waitForSelector('[data-chat-row]');await page.waitForTimeout(350);
  await page.evaluate(()=>fixture.all());await page.waitForTimeout(350);
  for(const phase of ['cold','warm']) {
   await page.evaluate(()=>fixture.source.latest());await page.waitForTimeout(350);
   const result=await page.evaluate(async()=>{
    const host=document.querySelector('.history'),top=host.getBoundingClientRect().top;
    const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
    const probe=window.measurementProbe;probe.shifts=[];probe.enabled=true;let maxFrameShift=0;
    for(let i=0;i<160;i++){
     const row=[...host.querySelectorAll('[data-chat-row]')].find(row=>row.getBoundingClientRect().bottom>top+1);
     const key=row.dataset.chatRow,before=row.getBoundingClientRect().top,from=host.scrollTop;
     host.scrollTop-=80;const requested=host.scrollTop-from;
     // Deliver the scroll offset before RO, as with browser input. A script
     // write inside rAF without a scroll event creates an artificial stale offset.
     host.dispatchEvent(new Event('scroll'));await frame();
     const same=[...host.querySelectorAll('[data-chat-row]')].find(row=>row.dataset.chatRow===key);
     if(same)maxFrameShift=Math.max(maxFrameShift,Math.abs(same.getBoundingClientRect().top-before+requested));
    }
    probe.enabled=false;return {maxFrameShift,resizeShifts:probe.shifts};
   });
   console.log(JSON.stringify({browser:browser.version(),records:total,phase,...result}));
   assert.ok(result.maxFrameShift<=2,'scrolling must not add movement beyond the requested delta');
   assert.deepEqual(result.resizeShifts,[],'resize delivery must leave scroll offset and row positions consistent');
  }
  assert.deepEqual(errors,[]);await page.close();
 }
} finally {await browser.close();}
