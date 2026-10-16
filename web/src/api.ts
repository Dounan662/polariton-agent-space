/** Structured failures let read views distinguish a removed file from a transient read. */
export class ApiError extends Error {
 readonly code:string; readonly status:number;
 constructor(code:string,message:string,status:number){super(message);this.name='ApiError';this.code=code;this.status=status;}
}
/** A rejected owner request can be corrected under a new request identity. A lost
 * response, timeout or unavailable owner still requires receipt recovery. */
export function operationOutcomeUnknown(error:unknown):boolean {
 return !(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408&&!/UNCERTAIN|UNAVAILABLE|TIMEOUT/.test(error.code));
}
/** Authenticated same-origin command/query boundary; callers receive domain errors without wire parsing. */
export async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T> {
 const response=await fetch(`/api${path}`,body===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 const result=await response.json();if(!response.ok)throw new ApiError(result.error?.code??'REQUEST_FAILED',result.error?.message??`Request failed (${response.status})`,response.status);return result as T;
}
export async function upload<T>(path:string,file:File,onProgress:(fraction:number)=>void):Promise<T> {
 return new Promise((resolve,reject)=>{const request=new XMLHttpRequest();request.open('POST',`/api${path}`);request.setRequestHeader('Content-Type','application/octet-stream');request.upload.onprogress=event=>{if(event.lengthComputable)onProgress(event.loaded/event.total);};request.onerror=()=>reject(new Error('Upload connection failed; retained operation can be retried'));request.onload=()=>{try{const value=JSON.parse(request.responseText);if(request.status>=400)reject(new Error(value.error?.message??'Upload failed'));else resolve(value as T);}catch(error){reject(error);}};request.send(file);});
}
export const uuid=()=>crypto.randomUUID();
