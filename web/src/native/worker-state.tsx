import {createContext,useContext,useState,type Dispatch,type SetStateAction} from 'react';
/** Host-owned presentation memory survives unmounting without retaining a second worker history. */
export const PresentationState=createContext<Map<string,unknown>|null>(null);
export function useWorkerState<T>(key:string,initial?:T|(()=>T)):[T,Dispatch<SetStateAction<T>>] {
 const memory=useContext(PresentationState);
 const [value,setValue]=useState<T>(()=>memory?.has(key)?memory.get(key) as T:typeof initial==='function'?(initial as ()=>T)():initial as T);
 return [value,next=>setValue(prior=>{const result=typeof next==='function'?(next as (prior:T)=>T)(prior):next;memory?.set(key,result);return result;})];
}
