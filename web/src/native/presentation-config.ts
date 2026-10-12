/** Presentation budgets shared by the native chat renderer and its nested scrollports. */
export interface ChatPresentationConfig{
 readonly processTitleMinimumMs:number
 readonly processScrollEpsilonPx:number
 readonly processMovementEpsilonPx:number
 readonly copyFeedbackMs:number
 readonly retryCountdownIntervalMs:number
 readonly toolCardLines:number
 readonly readPreviewLines:number
 readonly searchPreviewLines:number
 readonly diffPreviewLines:number
 readonly maxDiffEditLength:number
 readonly jsonPreviewChars:number
 readonly terminalTabWidth:number
}
export const chatPresentationConfig:ChatPresentationConfig=Object.freeze({
 processTitleMinimumMs:150,
 processScrollEpsilonPx:1,
 processMovementEpsilonPx:0.5,
 copyFeedbackMs:1000,
 retryCountdownIntervalMs:250,
 toolCardLines:16,
 readPreviewLines:8,
 searchPreviewLines:8,
 diffPreviewLines:9,
 maxDiffEditLength:256,
 jsonPreviewChars:20000,
 terminalTabWidth:8,
})
