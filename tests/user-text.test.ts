import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UserTextDocument} from '../web/src/native/client/ui-conversation/src/client/conversation/user-text-document.ts';
import {sessionReferenceRule} from '../web/src/native/client/ui-conversation/src/client/user-text/session-reference-rule.ts';
import {fileReferenceRule,folderReferenceRule} from '../web/src/native/client/ui-reference/src/client/user-text-rules.ts';
import {skillReferenceRule} from '../web/src/native/client/ui-skill/src/client/user-text-rules.ts';

const rules=[sessionReferenceRule,skillReferenceRule,fileReferenceRule,folderReferenceRule];

test('native user text preserves source ranges and resolves overlapping references by original position',()=>{
 const text='🙂 @types @src/@types/react/index.ts /review @"docs /review notes.md" @data/';
 const nodes=new UserTextDocument().evaluate({text,facts:{sessionLabels:['types'],skillNames:['review']}},rules);
 assert.equal(nodes.map(node=>text.slice(node.start,node.end)).join(''),text);
 assert.deepEqual(nodes.filter(node=>node.id!=='text').map(node=>[node.id,text.slice(node.start,node.end)]),[
  ['session','@types'],['file','@src/@types/react/index.ts'],['skill','/review'],['file','@"docs /review notes.md"'],['folder','@data/'],
 ]);
});

test('native user text refreshes confirmed skill facts without inventing suffix boundaries',()=>{
 const text='@research/plan /review /unknown',document=new UserTextDocument();
 const initial=document.evaluate({text,facts:{sessionLabels:['research']}},rules);
 assert.deepEqual(initial.filter(node=>node.id!=='text').map(node=>node.id),['session']);
 const updated=document.evaluate({text,facts:{sessionLabels:['research'],skillNames:['plan','review']}},rules);
 assert.deepEqual(updated.filter(node=>node.id!=='text').map(node=>[node.id,text.slice(node.start,node.end)]),[['session','@research'],['skill','/review']]);
 const withdrawn=document.evaluate({text,facts:{sessionLabels:['research']}},rules);
 assert.deepEqual(withdrawn,initial);
});

test('native user text recognizes wire sessions and leaves ordinary slash paths literal',()=>{
 const text='@[experiment](dsh-session:session-42) /plan.md /plan。 /plan /nfs/data';
 const nodes=new UserTextDocument().evaluate({text,facts:{skillNames:['plan']}},rules);
 assert.deepEqual(nodes.filter(node=>node.id!=='text').map(node=>[node.id,node.data]),[
  ['session',{label:'experiment'}],['skill',{name:'plan'}],
 ]);
 assert.equal(nodes.map(node=>text.slice(node.start,node.end)).join(''),text);
});
