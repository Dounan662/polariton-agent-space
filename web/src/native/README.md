# DSH presentation adaptation

Polariton adapts DeepSeek Harness conversation, trajectory, Markdown/math, syntax
highlighting, icons, stream reconciliation, and usage presentation for its browser UI.

The presentation release is DSH `0.2.1-rc.2`, revision
`687f282e8625c6b8d11ff58211a90524be2e4317`, matching the pinned runtime. All 244
attributed source entries were reviewed against this revision, including unchanged
sources and retained local adaptations. [ORIGIN.json](ORIGIN.json) lists copied source paths, upstream
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

## DSH 0.2.1 presentation refresh


The upgraded observation boundary consumes successful-attempt retirement at
`step/end`; transient tool preparation survives the durable assistant message and
then disappears without losing stable source identities. The native assembler
accepts table matchers and exclusive claims. Group-tree positions replace the
fixed list of independent row kinds, and notice-woken turns stay in their existing
human exchange. Tool arguments now use DSH's lazy `PartialArguments` view from
preparation through settlement. Recorded operation-time paths and cwd take
precedence over current workspace guesses; missing exit codes, terminating
signals and background acknowledgements retain their distinct presentation.
Trajectory adds streaming timing, correct retry status and interrupted-request
state. User content uses the new shared text document and reference rules.

The retained renderer boundary remains intentionally smaller than `dsh web`:
Polariton owns read-only source access, native dispatch, receipts, authorized image
loading, worker presentation memory and the outer viewport. Upstream image and
reasoning plugin slots bind to those existing typed local capabilities. Collapse
still occurs on completion; DSH's optional next-input preference and animated
outer-flow controller are not installed over Polariton's viewport. Shared neutral
menus and accessible body-portalled tooltips retain their local styling and
lifecycle. Native menu keyboard/composition/modal behavior and current weighted
icons are integrated without the desktop translucent-window backing.

Markdown incorporates native local-image syntax recovery, local-link parsing,
image previews and the current syntax grammar set. File classification is extracted
into the pure `../ui/file-types.ts` module so parsing does not depend on React/JSX;
both extracted and rendering sources retain provenance. Local filesystem image
resolution remains capability-scoped: unsupported paths do not become direct host
file URLs. Statistics use the current independent activity/usage pills fed by
Polariton's validated whole-session projections. The copied source inventory also
includes the newly reachable reference, image, terminal and keyboard primitives.

Regression coverage includes successful-stream retirement, notice exchange
boundaries, partial arguments, recorded path/cwd, unknown terminal exits,
background jobs, spaced local image syntax and reusable reference documents,
alongside existing pagination, failed-attempt identity, worker receipt and viewport
tests. See [compatibility](../../../docs/COMPATIBILITY.md) for verification scope.

The visual qualification also catches native sticky code headers under translated
virtual rows. Conversation rows select static header positioning so the banner
cannot cover the final source lines; nonvirtual code surfaces retain native sticky
behavior. `scripts/verify-chat-code-blocks.mjs` checks both text and header/source
geometry at two reading positions. The cold-restoration verifier seeds the new
page before application startup, avoiding an old page's visibility-change flush
racing the synthetic bookmark.
