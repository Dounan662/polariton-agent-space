import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {ComponentView} from '../src/environment/preparation-contracts.ts';

test('capability pages summarize five properties without hiding constraints or failures',async t=>{
 // Use the shipped JSX compiler, with no browser or application owner started.
 const compiler=await createServer({configFile:false,root:fileURLToPath(new URL('../web',import.meta.url)),server:{middlewareMode:true,watch:null,hmr:false,ws:false}});
 t.after(()=>compiler.close());
 const {CapabilityFacts}=await compiler.ssrLoadModule('/src/capability-facts.tsx');
 const value=ComponentView.parse({id:'browser',name:'Browser',source:{kind:'npm',identifier:'@playwright/mcp',version:'0.0.83'},runtime:{kind:'local'},connection:{kind:'stdio'},requirements:{assets:[{kind:'playwright-browser',browser:'chromium'}],storage:{scope:'capability',access:'exclusive',retention:'retain'},resource:{identity:'lab-browser',exclusive:true}},authentication:{kind:'none'},capabilityId:'browser',capabilityRevisionId:'revision-browser',error:null,evidence:{registered:true,dependencies:'ready',connection:'untested',tools:[],authentication:'not-required',checks:[{name:'navigate',status:'not-run'}],observedAt:null}});
 const html=renderToStaticMarkup(React.createElement(CapabilityFacts,{value,platform:{platform:'darwin',arch:'arm64'}}));
 const visible=html.slice(0,html.indexOf('<details'));
 for(const property of ['Source','Runtime','Connection','Requirements','Authentication'])assert(visible.includes(`<h2>${property}</h2>`),`${property} must not be hidden behind disclosure`);
 for(const fact of ['0.0.83','Local process','Connection untested','Dependencies ready','capability','exclusive','Retained storage','lab-browser','No authentication configured'])assert(visible.includes(fact),`Missing visible fact: ${fact}`);
 for(const fact of ['revision-browser','darwin','Node.js and npm','chromium','navigate']){
  assert(!visible.includes(fact),`${fact} is secondary to the ready summary`);
  assert(html.slice(html.indexOf('<details')).includes(fact),`${fact} remains available on demand`);
 }
 const scoped=renderToStaticMarkup(React.createElement(CapabilityFacts,{value,connectionEvidence:React.createElement('p',null,'Browser work v3: connected; 4 tools discovered')}));
 assert(scoped.includes('Browser work v3: connected; 4 tools discovered'));
 assert(!scoped.slice(0,scoped.indexOf('<details')).includes('Connection untested'),'Scoped validation replaces a misleading capability-wide status');
 const failed=renderToStaticMarkup(React.createElement(CapabilityFacts,{value:{...value,error:{code:'dependency_unavailable',message:'Browser asset missing'},evidence:{...value.evidence,dependencies:'unavailable',connection:'failed',checks:[{name:'navigate',status:'failed'}]}}}));
 const failedVisible=failed.slice(0,failed.indexOf('<details'));
 for(const fact of ['Dependencies unavailable','Node.js and npm','chromium','Connection failed','navigate: failed','Browser asset missing'])assert(failedVisible.includes(fact),`${fact} needs attention without opening a disclosure`);
});
