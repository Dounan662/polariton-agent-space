import type {ChatStoreState,TurnProcessViewEntry} from './contract/store.ts'
/** One manually expanded answer generation; state remains owned by the worker. */
export function storedTurnProcessEntry(state:Readonly<ChatStoreState>,turn:number):Readonly<TurnProcessViewEntry>|undefined{
 return state.turnProcesses.find(entry=>entry.turn===turn)
}
