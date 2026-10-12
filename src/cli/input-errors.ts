import {z} from 'zod';
import {Fault} from '../contracts.ts';

const kebab=(value:string)=>value.replace(/[A-Z]/g,c=>`-${c.toLowerCase()}`);
/** A CLI validation error identifies the failing input without echoing its value.
 * Schema refinements are authored constraints; no provider or request text is copied. */
export function invalidInvocation(error:z.ZodError,values:Record<string,unknown>,command:string,fields:readonly string[]):Fault{
 const messages=error.issues.map(issue=>{
  const path=issue.path.filter(part=>part!=='command'&&part!=='input');
  const known=typeof path[0]==='string'&&[...fields,'requestId','version'].includes(path[0]);
  const field=!known?'input':path[0]==='target'?'TARGET':path[0]==='version'?'--contract-version':path.length?`--${kebab(String(path[0]))}${path.slice(1).filter(part=>typeof part==='number').map(part=>`[${part}]`).join('')}`:'input';
  if(issue.code==='custom')return issue.message;
  if(issue.code==='unrecognized_keys')return 'Unsupported input fields; use the fields listed in command help';
  if(issue.code==='invalid_type'){
   let supplied:unknown=values;for(const part of path)supplied=supplied&&typeof supplied==='object'?(supplied as Record<PropertyKey,unknown>)[part]:undefined;
   return supplied===undefined?`Missing required ${field==='TARGET'?'argument':'option'}: ${field}`:`${field} must be ${issue.expected}`;
  }
  if(issue.code==='invalid_format')return `${field}: ${issue.format==='uuid'?'use a UUID':issue.message}`;
  if(issue.code==='invalid_value')return `${field}: choose ${issue.values.map(value=>JSON.stringify(value)).join(', ')}`;
  return `${field}: ${issue.message}`;
 });
 return new Fault('INVALID_INPUT',`${[...new Set(messages)].join('; ')}. See harnessctl ${command.replace('.',' ')} --help for usage and an example.`,400);
}
