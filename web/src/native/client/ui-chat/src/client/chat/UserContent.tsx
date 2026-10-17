/** Reusable user contents inside a caller-owned message row. */
import { Fragment } from 'react'
import type {MessageImageSource} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {ChatNodeOwnerProps,Translate} from '../contract/slots.ts'
import {UserText,type UserTextProps} from '../../../../ui-conversation/src/client/user-text/UserText.tsx'
import { fileExtension, FileTypeIcon, fileSizeText, JsonBlock } from '../../../../../chat-primitives.tsx'
import css from './MessageItem.module.css'

const EMPTY_LABELS: readonly string[] = []

/**
 * Render prepared text, ordered attachments, and references without message chrome.
 * The caller owns row identity, pending/echo state, time, and message actions.
 * @param props - prepared content, confirmed reference facts, authorized image presentation, and locale.
 * @returns the content stack using the existing user-message layout.
 */
export type UserContentAttachment =
 | {readonly type:'image';readonly image:MessageImageSource}
 | {readonly type:'file';readonly file:{name:string;bytes:number}}
export interface UserContentProps {
 content:{text:string;attachments:readonly UserContentAttachment[];extraBlocks:readonly unknown[];referenceLabels?:readonly string[]}
 facts:UserTextProps['facts']
 references?:UserTextProps['references']
 renderMessageImages:ChatNodeOwnerProps['renderMessageImages']
 t:Translate
}
export function UserContent({content,facts,references,renderMessageImages,t}:UserContentProps) {
  const { text, attachments, extraBlocks, referenceLabels = EMPTY_LABELS } = content
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || extraBlocks.length > 0
  return (
    <div className={css.userStack}>
      {attachments.length > 0 && (
        <div className={css.attachmentRow} data-message-attachments>
          {attachments.map((attachment, index) => attachment.type === 'image'
            ? (
              <Fragment key={`image:${index}`}>
                {renderMessageImages({
                  images: [attachment.image], align: 'end', compact: compactImages,
                })}
              </Fragment>
            )
            : (
              <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                <span className={css.fileContent}>
                  <span className={css.fileName}>{attachment.file.name}</span>
                  <span className={css.fileMeta}>
                    {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                      .filter(Boolean).join(' ')}
                  </span>
                </span>
              </span>
            ))}
        </div>
      )}
      {showBubble && <div className={css.bubble}>
        <UserText text={text} facts={facts} references={references}/>
        {extraBlocks.map((block, index) => (
          <JsonBlock key={index} stateKey={`extra:${index}`} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />
        ))}
      </div>}
      {referenceLabels.length > 0 && (
        <div className={css.referenceSummary}>
          {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
        </div>
      )}
    </div>
  )
}
