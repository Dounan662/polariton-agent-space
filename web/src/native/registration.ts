import type {ConversationGroupDefinition,ConversationNodeDefinition,ConversationViewDefinition,SystemPromptInspector,RequestPromptInspector} from './conversation.ts';
/** Presentation-only registration seat; deliberately has no execution, filesystem, or session activation services. */
export interface Context {
  uiConversation:{
    events:{register<T>(definition:ConversationNodeDefinition<T>):void;registerFallback<T>(definition:ConversationNodeDefinition<T>):void};
    views:{register<N extends import('./conversation.ts').ConversationViewNode,S>(definition:ConversationViewDefinition<N,S>):void};
    groups:{register<N extends import('./conversation.ts').ConversationViewNode,S,D>(definition:ConversationGroupDefinition<N,S,D>):void};
    inspectSystemPrompt:SystemPromptInspector;
    inspectRequestPrompt:RequestPromptInspector;
  };
}
