import { z } from 'zod';
import { Id } from './contracts.ts';

/** Workspace notifications carry identities only; Research Tree remains the file authority. */
export const WorkspaceScope = z.object({
  project: Id, node: Id, kind: z.enum(['directory', 'file']),
  path: z.string().refine(path => path === '' || (!path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => !!part && !['.', '..', '.git', '.polariton'].includes(part))), 'Expected an admitted workspace-relative path'),
}).strict().refine(scope => scope.kind !== 'file' || scope.path.length > 0, 'File observation needs a path');
export type WorkspaceScope = z.infer<typeof WorkspaceScope>;
export const WorkspaceChange = z.object({
  scope: WorkspaceScope, state: z.enum(['changed', 'unavailable']), detail: z.string().optional(), terminal: z.boolean().optional(),
}).strict();
export type WorkspaceChange = z.infer<typeof WorkspaceChange>;
