import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AttachmentId} from '@deepseek-ai/dsh-attachment';
import {deriveTrajectoryLayout, type TrajectoryLayoutInput} from '../web/src/native/client/ui-trajectory/src/client/layout.ts';
import {translate} from '../web/src/native/client/ui-trajectory/src/client/locales.ts';

const cells = (input: TrajectoryLayoutInput) => deriveTrajectoryLayout(input, translate)
  .flatMap(turn => turn.groups.flatMap(group => group.cells));

test('trajectory attachment presentation retains repeated image/file references and complete raw source', () => {
  const image = {attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const,
    bytes: 68, width: 640, height: 320, name: 'plot.png'};
  const file = {attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), bytes: 1024, name: 'notes.pdf'};
  const content = [{type: 'text' as const, text: 'Compare these'}, {type: 'image' as const, attachment: image},
    {type: 'file' as const, attachment: file}, {type: 'image' as const, attachment: image}];
  const [record] = cells({nodes: [{kind: 'user', seq: 1, time: 1000, source: null, content}],
    partial: null, runningCalls: []});
  assert.ok(record);
  assert.equal(record.text, 'Images ×2 · Files ×1');
  assert.equal(record.previewMarkdown, 'Compare these');
  const attachments = record.sourceBlocks?.filter(block => block.type !== 'text');
  assert.deepEqual(attachments?.map(block => block.attachment ?? block.file), [image, file, image]);
  assert.deepEqual(attachments?.map(block => JSON.parse(block.content)), content.slice(1));
});

test('trajectory explains tool registry changes without inventing model or tool execution', () => {
  const [record] = cells({nodes: [{kind: 'context', seq: 1, time: 1000, source: 'tool-registry',
    producer: {role: 'inject', label: 'tool-registry'}, form: null,
    content: [{type: 'tool-addition', toolName: 'search'}, {type: 'tool-removal', toolName: 'old_search'}]}],
    partial: null, runningCalls: []});
  assert.ok(record);
  assert.equal(record.kind, 'context');
  assert.equal(record.text, 'Tools updated · 1 added, 1 removed');
  assert.equal(record.inputDetail, 'Added: search\nRemoved: old_search');
});

test('trajectory displays tools only after dispatch supplies complete arguments', () => {
  const tool = {callId: 'call', name: 'inspect', turn: 1, step: 1, time: 1000, subCalls: []};
  assert.deepEqual(cells({nodes: [], partial: null, runningCalls: [{...tool, phase: 'preparing'}]}), []);
  const [record] = cells({nodes: [], partial: null, runningCalls: [{...tool, phase: 'start', argsRaw: '{"path":"plot.png"}'}]});
  assert.ok(record);
  assert.equal(record.kind, 'tool');
  assert.equal(record.text, 'inspect');
  assert.equal(record.previewMarkdown, '{"path":"plot.png"}');
  assert.equal(record.timeSeconds, null);
});
