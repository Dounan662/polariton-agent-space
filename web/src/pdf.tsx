import React,{useEffect,useRef,useState} from 'react';
import {getDocument,GlobalWorkerOptions,type PDFDocumentProxy} from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc=worker;
/** Render one bounded PDF page in a worker; document scripts and embedded actions never enter the DOM. */
export function PdfPreview({url,maxPages,maxPixels}:{url:string;maxPages:number;maxPixels:number}){
 const [document,setDocument]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[error,setError]=useState(''),[text,setText]=useState(''),canvas=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{let active=true;const controller=new AbortController();let task:ReturnType<typeof getDocument>|undefined;
  void fetch(url,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('PDF version is no longer available; reload the file');task=getDocument({data:new Uint8Array(await response.arrayBuffer()),isEvalSupported:false,useSystemFonts:true,wasmUrl:'/pdf/wasm/',standardFontDataUrl:'/pdf/standard_fonts/',cMapUrl:'/pdf/cmaps/',cMapPacked:true});const pdf=await task.promise;if(pdf.numPages>maxPages)throw new Error('PDF exceeds configured page limit');if(active){setDocument(pdf);setPage(1);setError('');}}).catch(error=>{if(active)setError(String(error));});
  return()=>{active=false;controller.abort();if(task)void task.destroy();};
 },[url,maxPages]);
 useEffect(()=>{if(!document||!canvas.current)return;let active=true,render:ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>|undefined;
  void document.getPage(page).then(async value=>{if(!active)return;const natural=value.getViewport({scale:1}),scale=Math.min(1.5,Math.sqrt(maxPixels/(natural.width*natural.height))),viewport=value.getViewport({scale}),target=canvas.current!;target.width=Math.ceil(viewport.width);target.height=Math.ceil(viewport.height);render=value.render({canvas:target,viewport});await render.promise;const content=await value.getTextContent();if(active)setText(content.items.map(item=>'str'in item?item.str:'').join(' '));}).catch(error=>{if(active)setError(String(error));});
  return()=>{active=false;render?.cancel();};
 },[document,page,maxPixels]);
 return <div className="pdf-preview">{error&&<p role="alert">{error}</p>}{document&&<div className="row"><button disabled={page===1} onClick={()=>setPage(n=>n-1)}>Previous page</button><small>Page {page} / {document.numPages}</small><button disabled={page===document.numPages} onClick={()=>setPage(n=>n+1)}>Next page</button></div>}<canvas ref={canvas} role="img" aria-label={text||`PDF page ${page}`}/></div>;
}
