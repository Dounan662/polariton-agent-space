import {readFile} from 'node:fs/promises';
import {z} from 'zod';

const prose=z.string().trim().min(1).refine(text=>!text.includes('{{')&&!text.includes('\u0000'),'Shared prompt must be literal prose without template references or NUL');
const Resource=z.object({identity:prose,about:prose,cli:prose,checkpoints:prose,collaboration:prose}).strict();
export const promptPolicy=z.object({maxSharedWords:z.number().int().positive()}).parse({maxSharedWords:900});

/** Read the installed operating contract independently of skill discovery. Invalid
 * packages fail launch visibly rather than falling back to workspace instructions. */
export async function loadPolaritonPrompt(path:URL=new URL('./polariton-prompt.json',import.meta.url)) {
 const resource=Resource.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readFile(path))));
 const identity=resource.identity;
 const shared=[['About Polariton and this worker',resource.about],['harnessctl',resource.cli],['Checkpoint rules',resource.checkpoints],['Worker creation and communication',resource.collaboration]].map(([title,text])=>`## ${title}\n\n${text}`).join('\n\n');
 const words=`${identity}\n${shared}`.split(/\s+/u).length;
 if(words>promptPolicy.maxSharedWords)throw new Error(`Polariton shared prompt exceeds ${promptPolicy.maxSharedWords} words (${words})`);
 return {identity,shared,words,bytes:Buffer.byteLength(`${identity}\n${shared}`)};
}
