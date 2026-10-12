import {useSyncExternalStore} from 'react';
import type {SourceObservation} from './observation.ts';
import {createSnapshotStore,type ObservableSnapshot} from './store.ts';
import type {ConversationGroupedView,GroupKey,RenderMessageImages} from './conversation.ts';
import type {ChatSnapshot} from './client/ui-chat/src/client/contract/snapshot.ts';
import type {ProcessGroupData} from './client/ui-chat/src/client/contract/process-groups.ts';
import type {ChatViewSlotProps,KeyedHook,Translate} from './client/ui-chat/src/client/contract/slots.ts';
import type {ChatStoreState} from './client/ui-chat/src/client/contract/store.ts';
import {presentationPolicyFor} from './client/ui-chat/src/client/presentation-policy.ts';
import {en,common} from './client/ui-chat/src/client/locale.ts';

const labels={...common,...en};
export const chatTranslate:Translate=(key,values)=>labels[key].replace(/\{(\w+)\}/g,(match,name:string)=>String(values?.[name]??match));

/** Keyed subscriptions belong to native records, independent of row lifetimes. */
function keyedHook<State>(read:(key:string)=>ObservableSnapshot<State>):KeyedHook<State>{
 function useValue(key:string):State;
 function useValue<Value>(key:string,select:(state:State)=>Value):Value;
 function useValue<Value>(key:string,select?:((state:State)=>Value)){
  const record=read(key),value=useSyncExternalStore(record.subscribe,record.getSnapshot);
  return select?select(value):value;
 }
 return useValue;
}

type ChatStateStore=ReturnType<typeof createSnapshotStore<ChatStoreState>>;

/** Bind native renderer inputs to a read-only worker. Only view state is writable;
 * the binding exposes no session activation, prompt dispatch, or log writer. */
export function bindChat(source:SourceObservation,chat:ChatSnapshot,groups:ConversationGroupedView<ProcessGroupData>,renderMessageImages:RenderMessageImages,inspectCall?:((callId:string)=>void)):ChatViewSlotProps{
 const memory=source.presentationState;
 let state=memory.get('chat:turn-processes') as ChatStateStore|undefined;
 if(!state){state=createSnapshotStore<ChatStoreState>({turnProcesses:[]});memory.set('chat:turn-processes',state);}
 const store=state;
 const policy=presentationPolicyFor('standard');
 return {
  useChatNode:keyedHook(key=>chat.nodes.source(key)),
  useChatNodeProcess:keyedHook(key=>chat.nodes.processSource(key)),
  useChatGroup:keyedHook(key=>groups.groupSource(key as GroupKey)),
  useChat(select){useSyncExternalStore(source.subscribe,source.getSnapshot);return select(source.engine.snapshot('chat') as ChatSnapshot);},
  usePresentation:select=>select(policy),
  useStore(select){return select(useSyncExternalStore(store.subscribe,store.getSnapshot));},
  actions:{setTurnProcessOpen(turn,answerStep,open){
   const current=store.getSnapshot(),previous=current.turnProcesses.find(entry=>entry.turn===turn);
   if(open&&previous?.answerStep===answerStep||!open&&!previous)return;
   const turnProcesses=current.turnProcesses.filter(entry=>entry.turn!==turn);
   if(open)turnProcesses.push({turn,answerStep});
   store.set({turnProcesses});
  }},
  loadImage:async attachment=>`/api${source.base}/image?id=${encodeURIComponent(attachment.attachmentId)}`,
  renderMessageImages,inspectCall,t:chatTranslate,
 };
}
