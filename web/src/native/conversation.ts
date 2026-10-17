export * from './client/ui-conversation/src/client/contract/conversation.ts';
export * from './client/ui-conversation/src/client/contract/records.ts';
export * from './client/ui-conversation/src/client/contract/context-producer.ts';
export * from './client/ui-conversation/src/client/contract/request-inspection.ts';
export * from './client/ui-conversation/src/client/contract/system-prompt.ts';
export type {MessageImageLoader,MessageImagesOwnerProps,ConvViewProps} from '@deepseek-ai/dsh-client-ui-conversation/client';
export * from './client/ui-conversation/src/client/contract/groups.ts';

/** Render images through the worker-authorized gallery without exposing plugin services. */
export type RenderMessageImages = (owner: Omit<import('@deepseek-ai/dsh-client-ui-conversation/client').MessageImagesOwnerProps, 'loadImage'>) => import('react').ReactNode;
