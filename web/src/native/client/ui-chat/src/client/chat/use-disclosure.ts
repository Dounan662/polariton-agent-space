/** A semantic node/block identity survives row recycling and worker switching. */
import {createContext,useContext} from 'react'
import {useWorkerState} from '../../../../../worker-state.tsx'
import type {UseDisclosure} from '../contract/slots.ts'
export const DisclosureIdentity=createContext<string>('chat')
export const useDisclosure:UseDisclosure=(key='main')=>{
 const identity=useContext(DisclosureIdentity)
 const [expanded,setExpanded]=useWorkerState<boolean>(`chat:disclosure:${identity}:${key}`,false)
 return {expanded,setExpanded,toggle:()=>setExpanded(value=>!value)}
}
