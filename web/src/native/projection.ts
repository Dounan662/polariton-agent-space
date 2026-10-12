import {ConversationNodeAssembler} from './client/ui-conversation/src/client/conversation/assembler.ts';
import {inspectRequestPrompt,inspectSystemPrompt,type ConversationGroupDefinition,type ConversationNodeDefinition,type ConversationViewDefinition} from './conversation.ts';
import type {Context} from './registration.ts';
import {registerConversationNodes} from './client/ui-chat/src/client/conversation-nodes/register.ts';
import {registerTrajectoryAssistantDefinition} from './client/ui-trajectory/src/client/trajectory-assistant-definition.ts';
import {registerTrajectoryCompactionDefinitions} from './client/ui-trajectory/src/client/trajectory-compaction-definition.ts';
import {registerTrajectoryMessageDefinitions} from './client/ui-trajectory/src/client/trajectory-message-definitions.ts';
import {registerTrajectoryRequestHeaderDefinition} from './client/ui-trajectory/src/client/trajectory-request-header-definition.ts';
import {registerTrajectoryToolDefinition} from './client/ui-trajectory/src/client/trajectory-tool-definition.ts';
import {registerTrajectoryConversationView} from './client/ui-trajectory/src/client/trajectory-snapshot-builder.ts';
/** One native projection engine owns the two presentations of each worker's loaded source. */
export function createPresentation() {
 const definitions:ConversationNodeDefinition[]=[],views:ConversationViewDefinition[]=[],groups:ConversationGroupDefinition[]=[];let fallback:ConversationNodeDefinition|undefined;
 const ctx:Context={uiConversation:{events:{register:definition=>{definitions.push(definition as ConversationNodeDefinition);},registerFallback:definition=>{fallback=definition as ConversationNodeDefinition;}},views:{register:definition=>{views.push(definition as ConversationViewDefinition);}},groups:{register:definition=>{groups.push(definition as ConversationGroupDefinition);}},inspectRequestPrompt,inspectSystemPrompt}};
 registerConversationNodes(ctx);
 registerTrajectoryAssistantDefinition(ctx);registerTrajectoryCompactionDefinitions(ctx);registerTrajectoryMessageDefinitions(ctx);registerTrajectoryRequestHeaderDefinition(ctx);registerTrajectoryToolDefinition(ctx);registerTrajectoryConversationView(ctx);
 const engine=new ConversationNodeAssembler({entries:()=>definitions,fallbackEntry:()=>fallback},{entries:()=>views},{entries:()=>groups,forTarget:target=>groups.find(group=>group.target===target)});
 engine.activateTarget('chat');engine.activateTarget('trajectory');return engine;
}
