# DSH presentation adaptation

Polariton adapts DeepSeek Harness conversation, trajectory, Markdown/math, syntax
highlighting, icons, stream reconciliation, and usage presentation for its browser UI.

The primary baseline is DSH `0.2.0-rc.2`, revision
`639ed015397290b3745d163aafe02ffee4aa3f84`, matching the pinned runtime. Unchanged
foundational files retain revision `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` in their
individual records. [ORIGIN.json](ORIGIN.json) lists copied source paths, upstream
and local hashes, and adaptations. The upstream [MIT license](LICENSE) is retained.

## Integration boundary

`presentation.ts` exposes observation and projection; `views.tsx` exposes rendering.
Application UI uses those entry points. Main supplies authorized media and saved
DSH source records. Rendering never starts a session or writes its history.
React 18.3.1 is the shared runtime; no DSH browser server or module loader is started.

`registration.ts`, `outlet.tsx`, and local barrels provide the application binding.
`conversation-rendering.tsx` connects source stores, translations, media access,
worker presentation state, and tool inspection to native chat rendering. It does
not simulate Harness plugin services.

## Local adaptations

- Conversation and trajectory share Polariton's workspace and right-hand inspector.
  Ordinary runtime-context rows are omitted from conversation but retained in trajectory.
- Completed math renders during streaming; incomplete syntax stays literal until valid.
- Authenticated worker messages retain worker attribution and receipt correlation.
  Their source remains distinct from human input; this does not change runtime authority.
- `useWorkerState` retains worker-specific presentation state. Native DSH session
  contracts remain unchanged.
- Shared tooltip, menu, and visual primitives live in `../ui`; their copied-file
  provenance remains in this inventory. Focus, Escape, portal placement, and submenu
  behavior are preserved through the application integration.
- `ConversationViewport` owns outer scrolling. Native process groups retain their
  nested scrolling and disclosure state; unusually large open groups can have
  linear DOM cost. Closed groups unmount their members.
- User receipt reconciliation wraps native messages without fabricating events.
  Tool inspection opens the corresponding native trajectory record. Media uses
  authorized Polariton routes.

## Changing adapted code

Review the proposed upstream revision and each affected file. Preserve notices,
record purposeful adaptations, update the provenance inventory, and run the build
and affected presentation/history tests. Do not recopy upstream files during an
application build or refresh hashes just to bypass a mismatch. See
[development](../../../docs/DEVELOPMENT.md) and [UI attribution](../../../docs/UI_ORIGIN.md).
