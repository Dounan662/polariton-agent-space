import {createContext,useContext,useEffect,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
/** Moves the complete native inspector into the host's shared Details panel, retaining its own selection state. */
export const InspectorContext=createContext<{element:HTMLElement|null;onInspect:()=>void}>({element:null,onInspect:()=>{}});
export function InspectorOutlet({children}:{children:ReactNode}) {
  const {element,onInspect}=useContext(InspectorContext);
  useEffect(()=>{onInspect();},[onInspect]);
  return element?createPortal(children,element):children;
}
