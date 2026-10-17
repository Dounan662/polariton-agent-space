import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

// Exercise the real native renderer inside translated virtual rows: source text
// in the DOM is insufficient when a sticky header paints over the final line.
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({headless:true,executablePath:process.argv[3]});
try{
 const page=await browser.newPage({viewport:{width:1280,height:850}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(process.env.POLARITON_PRESENTATION_FIXTURE_URL??'http://127.0.0.1:51821/tests/fixtures/adr022/');
 await page.waitForSelector('.md-code-block pre .line');
 for(const position of ['tail','earlier']){
  if(position==='earlier')await page.locator('.history').evaluate(element=>{element.scrollTop-=500;});
  await page.waitForTimeout(350);
  const blocks=await page.locator('.md-code-block').evaluateAll(elements=>elements.map(element=>{
   const header=element.querySelector('[data-code-block-banner]'),pre=element.querySelector('pre');
   const headerRect=header.getBoundingClientRect(),preRect=pre.getBoundingClientRect();
   return {text:pre.textContent,headerBottom:headerRect.bottom,sourceTop:preRect.top};
  }));
  assert.ok(blocks.length>0);
  for(const block of blocks){
   assert.equal(block.text,'signal = 42\nprint(signal)');
   assert.ok(block.headerBottom<=block.sourceTop+1,`${position}: code header overlaps source`);
  }
 }
 assert.deepEqual(errors,[]);
 console.log('Native code blocks preserve every source line without header overlap in translated rows.');
}finally{await browser.close();}
