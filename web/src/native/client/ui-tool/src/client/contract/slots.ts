/** Local rendering capabilities: recorded tools cannot execute host actions. */
import type {RenderMessageImages,MessageImageLoader,ToolCallBlock} from '../../../../../conversation.ts'
import type {UseDisclosure,OpenFileOptions} from '../../../../ui-chat/src/client/contract/slots.ts'
import type {ToolTranslate} from '../locales.ts'
export interface ToolCallOwnerProps{
 block:ToolCallBlock;toolName:string;cwd?:string|undefined;home?:string|undefined;
 openFile?:((path:string,options?:OpenFileOptions)=>void)|undefined;
 inspect?:(()=>void)|undefined;useDisclosure:UseDisclosure;renderMessageImages:RenderMessageImages;loadImage:MessageImageLoader
}
export interface ToolTreeProps{t:ToolTranslate}
