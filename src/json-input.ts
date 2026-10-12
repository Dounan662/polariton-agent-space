/** Public JSON input rejects repeated object keys before normalization can erase them.
 * Error diagnostics never contain user-provided keys or values. This module is shared
 * by browser paste, CLI files/stdin and HTTP boundaries. */
export function parseJsonInput(text:string):unknown{
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new JsonInputError('INVALID_JSON','Input must contain valid JSON');}
  const objects:Array<Set<string>|null>=[];
  // JSON.parse has already checked syntax. Tokens preserve quoted strings (including
  // escaped quotes), so nesting and decoded property identities remain unambiguous.
  const tokens=/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g;
  for(const token of text.matchAll(tokens)){
    const part=token[0];
    if(part==='{')objects.push(new Set());
    else if(part==='[')objects.push(null);
    else if(part==='}'||part===']')objects.pop();
    else if(part.startsWith('"')&&/^\s*:/.test(text.slice(token.index!+part.length))){
      const keys=objects.at(-1)! as Set<string>,key=JSON.parse(part) as string;
      if(keys.has(key))throw new JsonInputError('DUPLICATE_KEY','Repeated JSON object keys are not supported; use a unique name for each entry');
      keys.add(key);
    }
  }
  return value;
}
export class JsonInputError extends Error{
  readonly code:string;readonly statusCode=400;
  constructor(code:string,message:string){super(message);this.code=code;}
}
