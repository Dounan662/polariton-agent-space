/** Qualification requires completed successful tools, including shell exits that
 * DSH deliberately reports with isError=false. Match native trailing markers,
 * not similar text embedded in ordinary command output. Background work is not
 * proof of successful completion in these foreground qualification scenarios. */
export function toolFailure({name,result}){
 if(result.isError)return 'tool-error';
 if(name!=='bash')return null;
 const text=result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n').trimEnd();
 const exit=/(?:^|\n)\[exit code: ([^\]\n]+)\]$/.exec(text);
 if(exit&&exit[1]!=='0')return `bash-exit:${exit[1]}`;
 if(/(?:^|\n)\[(?:killed by signal:|timed out after |stopped:)[^\]\n]*\](?:\n\[exit code: [^\]\n]+\])?$/.test(text))return 'bash-interrupted';
 if(/(?:^|\n)\[still running after [^\]\n]+\]/.test(text))return 'bash-incomplete';
 return null;
}
