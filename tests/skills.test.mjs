import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Skills from '@deepseek-ai/dsh-skill';
import * as FilesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import * as ApplicationSkills from '../harness/skills.mjs';

/** Real DSH discovery and model-facing loader use a project with obsolete Polariton copies. */
for(const applicationFirst of [false,true])test(`installed Polariton skills outrank stale project skills; application registered ${applicationFirst?'first':'last'}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-skills-')),ctx=new Context();
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'.git'));
 const stale=[];
 for(const folder of ['.dsh','.agents'])for(const name of ['operate-labra','make-polariton-tool','project-analysis']){
  const directory=join(root,folder,'skills',name);await mkdir(directory,{recursive:true});
  const file=join(directory,'SKILL.md'),body=`---\nname: ${name}\ndescription: Project ${name}\n---\n${folder} original ${name} instructions\n`;
  await writeFile(file,body);stale.push([file,body]);
 }
 for(const plugin of [SystemPrompt,Skills,Tools,Agents,SkillTool])await ctx.plugin(plugin,{});
 if(applicationFirst)await ctx.plugin(ApplicationSkills,{});
 await ctx.plugin(FilesystemSkills,{dshHome:join(root,'user-dsh'),agentsHome:join(root,'user-agents'),watch:false});
 if(!applicationFirst)await ctx.plugin(ApplicationSkills,{});
 const agent={id:'worker',session:{header:{cwd:root}}};
 const catalog=await ctx.skills.list({cwd:root,scope:agent});
 assert.equal(catalog.length,3);
 for(const name of ['make-polariton-tool']){
  assert.equal(catalog.find(value=>value.name===name).provider,'polariton-application');
  const skill=await ctx.skills.get(name,{cwd:root,scope:agent});
  assert.equal(skill.provider,'polariton-application');
  assert.equal(skill.resourceBase.path,fileURLToPath(new URL(`../skills/${name}`,import.meta.url)));
  const loaded=await ctx.tools.execute({callId:`load-${name}`,name:'skill',arguments:{name},agent,signal:new AbortController().signal});
  assert.equal(loaded.isError,false,JSON.stringify(loaded));assert.equal(loaded.value.content,skill.content);assert.equal(loaded.value.provider,'polariton-application');
  assert.doesNotMatch(loaded.value.content,/original .* instructions/);
 }
 assert.equal((await ctx.skills.get('operate-labra',{cwd:root,scope:agent})).provider,'filesystem','Retired names remain ordinary user skills');
 const project=await ctx.skills.get('project-analysis',{cwd:root,scope:agent});
 assert.equal(project.provider,'filesystem');assert.equal(project.content,'.dsh original project-analysis instructions');
 for(const [file,body] of stale)assert.equal(await readFile(file,'utf8'),body,'Application precedence never rewrites project files');
 const canceled=new AbortController();canceled.abort(new Error('Canceled lookup'));
 await assert.rejects(ctx.skills.get('operate-labra',{cwd:root,scope:agent,signal:canceled.signal}),/Canceled lookup/);
});

/** Separate harness homes discover the same defaults without copying them into workspaces. */
test('shared skills preserve application, project, shared and user precedence across workers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-shared-skills-')),contexts=[];
 t.after(async()=>{for(const ctx of contexts)await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});});
 const shared=join(root,'defaults');
 const put=async(directory,name,text)=>{const folder=join(directory,name);await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),`---\nname: ${name}\ndescription: ${text}\n---\n${text}\n`);};
 await put(shared,'common-analysis','Shared analysis');await put(shared,'operate-labra','Stale shared application skill');
 for(const name of ['first','second']){
  const cwd=join(root,name),home=join(root,`${name}-home`);await mkdir(join(cwd,'.git'),{recursive:true});
  await put(join(home,'skills'),'common-analysis','User analysis');
  if(name==='first')await put(join(cwd,'.agents','skills'),'common-analysis','Project analysis');
  const ctx=new Context();contexts.push(ctx);
  for(const plugin of [SystemPrompt,Skills])await ctx.plugin(plugin,{});
  await ctx.plugin(FilesystemSkills,{dshHome:home,agentsHome:join(root,'user-agents'),customSkillDirs:[shared],watch:false});
  await ctx.plugin(ApplicationSkills,{});
  const catalog=await ctx.skills.list({cwd});
  assert.equal(catalog.filter(value=>value.name==='common-analysis').length,1);
  assert.equal((await ctx.skills.get('common-analysis',{cwd})).content,name==='first'?'Project analysis':'Shared analysis');
  assert.equal((await ctx.skills.get('operate-labra',{cwd})).provider,'filesystem');
  assert.equal((await ctx.skills.get('make-polariton-tool',{cwd})).provider,'polariton-application');
 }
});

test('shared discovery accepts an empty directory and refreshes using the pinned DSH watcher', {timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-shared-refresh-')),ctx=new Context(),shared=join(root,'defaults');
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});});
 await mkdir(shared);await mkdir(join(root,'.git'));
 for(const plugin of [SystemPrompt,Skills])await ctx.plugin(plugin,{});
 await ctx.plugin(FilesystemSkills,{dshHome:join(root,'home'),agentsHome:join(root,'agents'),customSkillDirs:[shared],watch:true,watchUsePolling:true,watchPollIntervalMs:10,watchStabilityThresholdMs:10});
 assert.deepEqual(await ctx.skills.list({cwd:root}),[]);
 // Await the public change event rather than sleeping for a guessed watcher delay.
 const change=expected=>new Promise((resolve,reject)=>{const off=ctx.on('skills/change',async()=>{try{const skill=await ctx.skills.get('new-analysis',{cwd:root});if(skill?.content===expected){off();resolve();}}catch(error){off();reject(error);}});});
 let changed=change('Initial body');const folder=join(shared,'new-analysis');await mkdir(folder);
 await writeFile(join(folder,'SKILL.md'),'---\nname: new-analysis\ndescription: Shared analysis\n---\nInitial body\n');
 await changed;
 assert.equal((await ctx.skills.get('new-analysis',{cwd:root})).content,'Initial body');
 changed=change('Updated body');await writeFile(join(folder,'SKILL.md'),'---\nname: new-analysis\ndescription: Updated description\n---\nUpdated body\n');
 await changed;
 assert.equal((await ctx.skills.get('new-analysis',{cwd:root})).content,'Updated body');
 assert.equal((await ctx.skills.list({cwd:root})).find(value=>value.name==='new-analysis').description,'Updated description');
});
