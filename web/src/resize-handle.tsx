import React, {useCallback, useEffect, useRef, useState} from 'react';

/** Owns one resize gesture, including capture and cancellation. Selection is
 * suppressed only while dragging; ordinary text selection resumes on every exit. */
export function ResizeHandle({step,label,width,onChange,reverse=false}:{step:number;label:string;width:number;onChange:(width:number)=>void;reverse?:boolean}) {
 const drag=useRef<{x:number;width:number;pointerId:number;element:HTMLDivElement}|null>(null);
 const [resizing,setResizing]=useState(false);
 const finish=useCallback(()=>{
  const current=drag.current;
  if(!current)return;
  drag.current=null;
  if(current.element.hasPointerCapture(current.pointerId))current.element.releasePointerCapture(current.pointerId);
  setResizing(false);
 },[]);
 useEffect(()=>{
  const hidden=()=>{if(document.hidden)finish();};
  window.addEventListener('blur',finish);
  document.addEventListener('visibilitychange',hidden);
  return()=>{window.removeEventListener('blur',finish);document.removeEventListener('visibilitychange',hidden);finish();};
 },[finish]);
 return <div className="panel-resizer" data-resizing={resizing||undefined} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={window.innerWidth} aria-valuenow={Math.round(width)} tabIndex={0}
  onKeyDown={event=>{
   if(event.key==='Escape'){finish();return;}
   if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();onChange(width+(event.key==='ArrowRight'?step:-step)*(reverse?-1:1));}
  }}
  onPointerDown={event=>{
   if(event.button!==0||!event.isPrimary||drag.current)return;
   // Pointer capture routes movement; it does not cancel the browser's selection default.
   event.preventDefault();
   event.currentTarget.focus({preventScroll:true});
   event.currentTarget.setPointerCapture(event.pointerId);
   drag.current={x:event.clientX,width,pointerId:event.pointerId,element:event.currentTarget};
   setResizing(true);
  }}
  onPointerMove={event=>{const current=drag.current;if(current?.pointerId===event.pointerId)onChange(current.width+(event.clientX-current.x)*(reverse?-1:1));}}
  onPointerUp={event=>{if(drag.current?.pointerId===event.pointerId)finish();}}
  onPointerCancel={event=>{if(drag.current?.pointerId===event.pointerId)finish();}}
  onLostPointerCapture={event=>{if(drag.current?.pointerId===event.pointerId)finish();}}
 />;
}
