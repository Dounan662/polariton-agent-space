import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {RenderMessageImages} from './conversation.ts';

type ImageGroup=Parameters<RenderMessageImages>[0];

/** All durable media resolves through the worker's authorized route. Native
 * attachment rows receive thumbnails; opening one shows the same retained image. */
export function RecordedImages({base,images,align,thumbnail,compact}:ImageGroup&{base:string}){
 const [selected,setSelected]=useState<number|null>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 const selectedImage=selected===null?undefined:images[selected];
 useEffect(()=>{if(selectedImage&&!dialog.current?.open)dialog.current?.showModal();},[selectedImage]);
 const resolve=(image:ImageGroup['images'][number])=>'attachment' in image
  ?{url:`/api${base}/image?id=${encodeURIComponent(image.attachment.attachmentId)}`,label:image.label??image.attachment.name??'Retained image'}
  :{url:image.preview.url,label:image.preview.name??'Attached image'};
 return <div className="recorded-media" data-align={align} data-thumbnail={thumbnail||undefined} data-compact={compact||undefined}>
  {images.map((image,index)=>{const value=resolve(image);return <button className="recorded-image" key={value.url} aria-label={`Open ${value.label}`} onClick={()=>setSelected(index)}><RetainedImage src={value.url} label={value.label}/></button>;})}
  {selectedImage&&createPortal(<dialog ref={dialog} className="recorded-image-dialog" aria-label={resolve(selectedImage).label} onCancel={()=>setSelected(null)} onClose={()=>setSelected(null)}>
   <button autoFocus className="recorded-image-close" aria-label="Close image" onClick={()=>setSelected(null)}>×</button>
   <RetainedImage key={resolve(selectedImage).url} src={resolve(selectedImage).url} label={resolve(selectedImage).label}/>
  </dialog>,document.body)}
 </div>;
}

function RetainedImage({src,label}:{src:string;label:string}){
 const [failed,setFailed]=useState(false);
 return failed?<span role="alert">{label} is unavailable.</span>:<img src={src} alt={label} onError={()=>setFailed(true)}/>;
}
