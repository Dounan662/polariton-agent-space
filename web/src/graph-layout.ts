import {z} from 'zod';

const point=z.object({x:z.number().finite(),y:z.number().finite()});
const receipt=z.object({id:z.string(),fingerprint:z.string(),revision:z.string().min(1)});
const savedLayout=z.object({
  positions:z.record(z.string(),point),
  viewport:point.extend({zoom:z.number().finite().positive()}).optional(),
  revision:z.string().min(1).default('0'),
  receipts:z.array(receipt).default([]),
});
export type Point=z.infer<typeof point>;
type Viewport=Point & {zoom:number};
type Placement={id:string;position:Point};
type Saved=z.infer<typeof savedLayout>;
export type LayoutLocks={request<T>(name:string,options:{ifAvailable:boolean},callback:(acquired:boolean)=>Promise<T>):Promise<T>};

export class LayoutError extends Error {
  readonly code:string;
  constructor(code:string,message:string){super(message);this.code=code;}
}

/** Owns browser-local presentation and serializes edits across tabs. A drag holds the
 * project lock until settlement; workers never queue behind or overwrite that drag.
 * Persistence precedes notifications and receipts share the same atomic storage write. */
export class GraphLayout {
  private readonly key:string;
  private readonly listeners=new Set<()=>void>();
  private dragging=false;
  private finishDrag:((nodes:readonly Placement[]|null)=>void)|undefined;
  private dragTask:Promise<void>|undefined;

  private readonly storage:Pick<Storage,'getItem'|'setItem'>;
  private readonly locks:LayoutLocks;
  private readonly newRevision:()=>string;
  constructor(storage:Pick<Storage,'getItem'|'setItem'>,project:string,locks:LayoutLocks,newRevision:()=>string=()=>crypto.randomUUID()) {
    this.storage=storage;this.locks=locks;this.newRevision=newRevision;this.key=`polariton.graph.${project}`;
  }

  private read():Saved {
    const encoded=this.storage.getItem(this.key);
    if(encoded){try{const parsed=savedLayout.safeParse(JSON.parse(encoded));if(parsed.success)return parsed.data;}catch{/* Malformed presentation cannot block research access. */}}
    return {positions:{},revision:'0',receipts:[]};
  }
  private current():Saved {const saved=this.read();if(saved.revision==='0'){saved.revision=this.newRevision();this.write(saved);}return saved;}
  private write(saved:Saved):void {this.storage.setItem(this.key,JSON.stringify(saved));this.refresh();}
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  refresh=():void=>{for(const listener of this.listeners)listener();};
  get revision():string{return this.read().revision;}
  get viewport():Viewport|undefined{return this.read().viewport;}
  positions(ids:readonly string[]):Record<string,Point>{const saved=this.read();return Object.fromEntries(ids.map((id,index)=>[id,saved.positions[id]??{x:80+(index%2)*320,y:80+Math.floor(index/2)*220}]));}

  /** Read settled positions atomically. Reads during a human drag report busy rather
   * than pretending the saved starting positions describe the visible canvas. */
  async inspect(ids:readonly string[]):Promise<{revision:string;positions:Record<string,Point>}> {
    return this.exclusive(()=>{const saved=this.current();return {revision:saved.revision,positions:Object.fromEntries(ids.map((id,index)=>[id,saved.positions[id]??{x:80+(index%2)*320,y:80+Math.floor(index/2)*220}]))};});
  }

  private async exclusive<T>(action:()=>T):Promise<T> {
    if(this.dragging)throw new LayoutError('CANVAS_BUSY','A human is dragging cards. Read the canvas again after the drag finishes.');
    return this.locks.request(this.key,{ifAvailable:true},async acquired=>{
      if(!acquired||this.dragging)throw new LayoutError('CANVAS_BUSY','The canvas is being edited in another tab. Try again after the edit finishes.');
      return action();
    });
  }

  /** Applies an entire worker batch or none. Exact retries return their original
   * receipt even after subsequent human edits; changed retry input is rejected. */
  async move(nodes:readonly Placement[],expected:string,requestId:string,receiptLimit:number,check:()=>void=()=>{}):Promise<string> {
    const placements=nodes.map(node=>({id:node.id,position:point.parse(node.position)}));
    const fingerprint=JSON.stringify({expected,placements});
    return this.exclusive(()=>{
      check();const saved=this.current(),prior=saved.receipts.find(value=>value.id===requestId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new LayoutError('REQUEST_ID_CONFLICT','Request ID was already used for a different canvas move.');return prior.revision;}
      if(saved.revision!==expected)throw new LayoutError('CANVAS_STALE',`Layout changed from revision ${expected} to ${saved.revision}. Read the canvas before moving cards.`);
      const revision=this.newRevision();
      this.write({...saved,positions:{...saved.positions,...Object.fromEntries(placements.map(node=>[node.id,node.position]))},revision,
        receipts:[...saved.receipts,{id:requestId,fingerprint,revision}].slice(-receiptLimit)});
      return revision;
    });
  }

  /** Claims a drag before asynchronous browser lock acquisition. The same-tab busy
   * flag closes the admission gap; Web Locks provide the cross-tab exclusion. */
  beginDrag():Promise<void> {
    if(this.dragTask)return this.dragTask;
    this.dragging=true;
    const settled=new Promise<readonly Placement[]|null>(resolve=>{this.finishDrag=resolve;});
    this.dragTask=this.locks.request(this.key,{ifAvailable:true},async acquired=>{
      if(!acquired)throw new LayoutError('CANVAS_BUSY','Another tab is editing this canvas. Your drag was not saved.');
      const nodes=await settled;
      if(nodes?.length){const saved=this.read();const positions={...saved.positions};for(const node of nodes)positions[node.id]=point.parse(node.position);this.write({...saved,positions,revision:this.newRevision()});}
    }).finally(()=>{this.dragging=false;this.finishDrag=undefined;this.dragTask=undefined;this.refresh();});
    return this.dragTask;
  }
  endDrag(nodes:readonly Placement[]|null):void {this.finishDrag?.(nodes);}
  async setViewport(viewport:Viewport):Promise<void> {
    const valid=savedLayout.shape.viewport.unwrap().parse(viewport);
    await this.locks.request(this.key,{ifAvailable:false},async()=>{this.write({...this.read(),viewport:valid});});
  }
}

const layouts=new Map<string,GraphLayout>();
/** One owner per project in a tab; storage events reconcile other tabs without
 * replacing the local camera. Unsupported browsers fail closed for coordinated edits. */
export function graphLayout(project:string):GraphLayout {
  let owner=layouts.get(project);
  if(!owner){
    const locks:LayoutLocks={request:async(name,options,callback)=>{
      if(!navigator.locks)throw new LayoutError('CANVAS_UNSUPPORTED','This browser requires Web Locks support for coordinated canvas editing.');
      return navigator.locks.request(name,options,lock=>callback(lock!==null));
    }};
    owner=new GraphLayout(localStorage,project,locks);layouts.set(project,owner);
  }
  return owner;
}
if(typeof window!=='undefined')window.addEventListener('storage',event=>{
  if(event.storageArea!==localStorage)return;
  for(const [project,owner]of layouts)if(event.key===null||event.key===`polariton.graph.${project}`)owner.refresh();
});
