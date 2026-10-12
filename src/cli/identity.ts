import {createHash} from 'node:crypto';

/** CLI mutation identities are stable across owner admission, retry and presentation. */
export function identity(request:string,kind:string){const h=createHash('sha256').update(`${kind}:${request}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
