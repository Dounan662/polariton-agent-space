/** Narrow snapshot contract and observer dispatch adapted from DSH client/store (see ORIGIN.json). */
export interface ObservableSnapshot<T> { getSnapshot():T; subscribe(listener:()=>void):()=>void }
export interface SnapshotStore<T> extends ObservableSnapshot<T> { update(mutator:(draft:T)=>void):void;set(next:T):void }
export function notifySubscribers<Args extends readonly unknown[]>(listeners:Iterable<(...args:Args)=>void>,label:string,...args:Args):void {
  for(const listener of [...listeners]) {try{listener(...args);}catch(error){console.error(`${label} subscriber failed:`,error);}}
}
/** Publishes immutable replacement values synchronously, isolating observer failures. */
export function createSnapshotStore<T>(initial:T):Pick<SnapshotStore<T>,'getSnapshot'|'subscribe'|'set'> {
  let snapshot=initial;
  const listeners=new Set<()=>void>();
  return {
    getSnapshot:()=>snapshot,
    subscribe(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    set(next){if(Object.is(snapshot,next))return;snapshot=next;notifySubscribers(listeners,'[native-store]');},
  };
}
