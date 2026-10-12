import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]});
try{
 const page=await browser.newPage({viewport:{width:1000,height:700}}),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(process.env.POLARITON_METRICS_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/metrics/');
 const time=page.getByRole('button',{name:'1 turns 11 steps · 280 tok/s'});
 const usage=page.getByRole('button',{name:'161K tok · Cache hit 93%'});
 const context=page.getByRole('button',{name:'2% of context used'});
 await time.click();const stats=page.getByRole('dialog',{name:'Session statistics'});
 assert.match(await stats.innerText(),/28.7s/);assert.match(await stats.innerText(),/0.6s/);assert.match(await stats.innerText(),/1s/);assert.match(await stats.innerText(),/280 tok\/s/);
 await usage.click();assert.equal(await stats.count(),0);
 const tokens=page.getByRole('dialog',{name:'Token usage'});
 for(const text of ['161,301 tok','11,211 tok','145,024 tok','5,066 tok'])assert.ok((await tokens.innerText()).includes(text));
 await page.keyboard.press('Escape');assert.equal(await tokens.count(),0);
 await context.click();const panel=page.getByRole('dialog',{name:'Context usage'});
 for(const text of ['~22K / 1M','~1.5K','~5.3K','~13.1K'])assert.ok((await panel.innerText()).includes(text));
 await page.screenshot({path:'/tmp/polariton-session-metrics.png'});
 const colors=await panel.evaluate(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}));assert.notEqual(colors.background,'rgba(0, 0, 0, 0)');
 for(const width of [375,1000]){
  await page.setViewportSize({width,height:700});
  await page.waitForTimeout(100);
  const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,JSON.stringify(box));
 }
 await page.mouse.click(20,20);assert.equal(await panel.count(),0);
 // Keyboard activation and projection replacement while a panel is open.
 await context.focus();await page.keyboard.press('Enter');await panel.waitFor();
 await page.evaluate(()=>fixture.replace({...fixture.metrics,contextPressure:{}}));assert.equal(await context.count(),0);assert.equal(await panel.count(),0);
 await page.evaluate(()=>fixture.source.snapshot({generation:'empty',page:null,assistantStream:{revision:0}}));assert.equal(await time.count(),0);assert.equal(await usage.count(),0);
 assert.deepEqual(errors,[]);console.log('Native metrics: exact values, keyboard/click dismissal, live replacement, viewport clamping and empty state passed.',browser.version());
}finally{await browser.close();}
